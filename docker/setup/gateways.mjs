// AI gateways: one address and key, reaching any agent that can use them.
//
// The store holds what someone asked for; T3 Code holds what is running. The
// service compares the two and writes only what differs, because writing a
// provider instance restarts it and stops the threads running on it. Every
// gateway instance is separate from the agent's default instance, so a gateway
// can never take over a direct sign-in, and removing one leaves that sign-in
// exactly as it was.
//
//   status()   the store, joined with T3's live state, the Vault and conflicts
//   test()     probe an address, saved or not
//   create(), save(), setAgent(), reapply(), refreshModels(), remove()
//
// Probing and applying are separate: a saved gateway can always be retried, and
// a partial failure leaves a row that says which agent needs it.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ACCENTS, AGENTS, NO_KEY, PRESETS, PROTOCOLS, UNSUPPORTED_AGENTS, agentOf, presetOf } from './gateways/catalog.mjs';
import { parseAddress, suggestName } from './gateways/address.mjs';
import { cleanModelIds, validModelId } from './gateways/models.mjs';
import { desiredInstance, differences, fileText, filesFor, instanceIdFor, mergeInstance, modelsFor, modelsToHide, reachesProcess } from './gateways/adapters.mjs';
import { probeGateway } from './gateways/probe.mjs';
import { clearClaudeSettings, scanClaudeSettings } from './gateways/conflicts.mjs';
import { createGatewayStore, gatewayFilesDir, writePrivate } from './gateways/store.mjs';

export class GatewayError extends Error {
  constructor(message, status = 400, code = 'invalid', extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const gatewayFailure = error => {
  if (error instanceof GatewayError) return { status: error.status, body: { ok: false, code: error.code, error: error.message, ...error.extra } };
  const status = { conflict: 409, invalid: 400, 'key-needed': 409 }[error?.code] ?? 500;
  return { status, body: { ok: false, code: error?.code ?? 'failed', error: String(error?.message ?? 'The gateway change did not finish.').slice(0, 300) } };
};

export const GATEWAY_ROUTES = Object.freeze(['/gateways', '/gateways/test', '/gateways/create', '/gateways/save', '/gateways/agent', '/gateways/apply', '/gateways/models', '/gateways/remove', '/gateways/conflict']);

const MAX_NAME = 40;
const COSMETIC = new Set(['name', 'accent']);
/** `#gateways/new` opens the Add sheet, so nothing can be called that. */
const RESERVED_IDS = Object.freeze(['new']);
const PROBE_REUSE_MS = 120_000;
const SETTLE_ATTEMPTS = 20;
const SETTLE_DELAY_MS = 1500;
const READ_REUSE_MS = 1000;

/** T3 lists an instance as not installed, with a fresh timestamp, until its first check is done. */
const hasStarted = provider => provider?.installed === true;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'gateway';
const cleanName = value => {
  const name = String(value ?? '').trim();
  if (!name) throw new GatewayError('Give this gateway a name.', 400, 'invalid', { field: 'name' });
  if (name.length > MAX_NAME || /[\x00-\x1f\x7f]/.test(name)) throw new GatewayError(`Use up to ${MAX_NAME} characters for the name, on one line.`, 400, 'invalid', { field: 'name' });
  return name;
};
const cleanKey = value => {
  if (value === undefined || value === null) return undefined;
  const key = String(value).trim();
  if (key.length > 4096 || /[^\x21-\x7e]/.test(key)) throw new GatewayError('An API key is one line of plain characters, without spaces.', 400, 'invalid', { field: 'key' });
  return key;
};
const cleanAddress = value => {
  const parsed = parseAddress(value);
  if (!parsed.ok) throw new GatewayError(parsed.error, 400, 'invalid', { field: 'url' });
  return parsed;
};
const cleanManual = values => {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 64 || !values.every(validModelId)) throw new GatewayError('Enter model IDs without spaces, up to 64 of them.', 400, 'invalid', { field: 'manual' });
  return cleanModelIds(values);
};

/** The part of a probe worth keeping. Never holds a key or a response body. */
/** How many models each agent would show, so the page never repeats the rules for that. */
const offersOf = probe => Object.fromEntries(AGENTS.map(agent => [agent.id, modelsFor(agent, { models: { ids: probe.models.ids } }).length]));

const checkOf = probe => ({ at: probe.at, ok: probe.ok, code: probe.code, ms: probe.ms ?? null, message: probe.message ?? null, hint: probe.hint ?? null, count: probe.models.ids.length, listed: probe.models.listed, protocols: probe.protocols });

/** A health check records what it saw. Models it finds wait in `latest` until someone chooses to apply them: applying restarts instances. */
const observed = (gateway, probe) => {
  const ids = probe.ok && probe.models.listed ? cleanModelIds(probe.models.ids) : null;
  const same = ids && JSON.stringify(ids) === JSON.stringify(gateway.models?.ids ?? []);
  return { check: checkOf(probe), latest: !ids ? gateway.latest ?? null : same ? null : ids };
};

export function createGatewayService({ baseDir, home, env = process.env, io, t3, vault, processes, fetchImpl = globalThis.fetch, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onEvent = () => {} }) {
  const store = createGatewayStore({ io, baseDir }), filesDir = gatewayFilesDir(baseDir);
  const probes = new Map();       // digest of address and key -> { at, probe }, so Connect reuses the test just shown
  const settling = new Map();     // gateway id -> { started, again }, while its instances start
  let read = null, readAt = 0, queue = Promise.resolve();

  // One change at a time: each reads T3 and the Vault, then writes both.
  const serial = work => { const run = queue.catch(() => {}).then(work); queue = run; return run; };

  const fingerprint = (url, key) => createHash('sha256').update(`${url}\0${key}`).digest('hex');
  const remember = (url, key, probe) => { probes.set(fingerprint(url, key), { at: now(), probe }); for (const [id, entry] of probes) if (now() - entry.at > PROBE_REUSE_MS) probes.delete(id); return probe; };
  const probe = async (url, key) => remember(url, key, await probeGateway({ url, key, fetchImpl, now }));
  const recentProbe = (url, key) => { const entry = probes.get(fingerprint(url, key)); return entry && now() - entry.at <= PROBE_REUSE_MS && entry.probe.ok ? entry.probe : null; };

  const readT3 = async ({ fresh = false } = {}) => {
    if (!fresh && read && now() - readAt < READ_REUSE_MS) return read;
    const pending = t3.read().then(value => ({ ok: true, ...value }), error => ({ ok: false, error: String(error?.message ?? error).slice(0, 240), code: error?.code ?? 'unavailable', instances: {}, providers: [] }));
    read = pending; readAt = now();
    return pending;
  };
  const invalidate = () => { read = null; readAt = 0; };
  const requireT3 = async () => {
    const state = await readT3({ fresh: true });
    if (!state.ok) throw new GatewayError(state.error, 503, 'unavailable');
    return state;
  };
  const keyFor = async gateway => {
    if (!gateway.credentialId) return '';
    try { return await vault.read(gateway.credentialId); }
    catch { throw new GatewayError(`The key ${gateway.credentialId} is no longer in the Vault. Replace it to continue.`, 409, 'key-missing'); }
  };
  /** The store, refusing a change that started from an older list. */
  const current = async revision => {
    const read = await store.read();
    if (revision !== read.revision) throw new GatewayError('Gateways changed in another window. Refresh and try again.', 409, 'conflict');
    return read;
  };
  const find = (gateways, id) => {
    const gateway = gateways.find(entry => entry.id === id);
    if (!gateway) throw new GatewayError('This gateway no longer exists. Refresh the list.', 404, 'gone');
    return gateway;
  };

  // --- reconciling ----------------------------------------------------------

  /** When the key in the Vault last changed. Instances stamped with an older value hold an old copy. */
  const keyStamp = async gateway => {
    if (!gateway.credentialId) return null;
    const entry = (await vault.list().catch(() => [])).find(row => row.id === gateway.credentialId);
    return entry ? entry.changedAt : undefined;
  };

  /**
   * Make T3 match one gateway. Each agent stands alone, so one failure leaves the
   * others done. A `key` passed here is one someone just chose, and always applies.
   * `quiet` means only the name changed, which no running process needs to hear.
   */
  const reconcile = async (gateway, { state, key, renamed = false, quiet = false } = {}) => {
    const results = [], agents = { ...gateway.agents }, stamp = await keyStamp(gateway);
    for (const agent of AGENTS) {
      const instanceId = instanceIdFor(gateway.id, agent), wanted = gateway.agents[agent.id], actual = state.instances[instanceId];
      if (!wanted?.on && !actual) continue;
      try {
        // An agent turned off keeps its instance, so its threads stay readable.
        if (!wanted?.on) {
          if (actual.enabled === false) { results.push({ agent: agent.id, ok: true, action: 'none' }); continue; }
          await processes.stop(agent.id, instanceId).catch(() => 0);
          await t3.upsert(instanceId, { ...actual, enabled: false });
          results.push({ agent: agent.id, ok: true, action: 'updated' });
          continue;
        }
        const desired = desiredInstance(agent, gateway, { instances: state.instances, enabled: true, dir: filesDir });
        const changed = differences(agent, desired, actual).filter(name => renamed || !COSMETIC.has(name));
        // A key deleted from the Vault leaves the working copy alone.
        const stale = key !== undefined || (stamp !== undefined && wanted.keyAt !== stamp);
        const lostSecret = desired.environment.some(row => row.secret && changed.includes(row.name));
        const secret = !actual || stale || lostSecret ? key ?? await keyFor(gateway) : undefined;
        const rewritten = await writeAgentFiles(agent, gateway, secret, { quiet });
        if (!changed.length && !stale && !rewritten) { results.push({ agent: agent.id, ok: true, action: 'none' }); continue; }
        const merged = mergeInstance(agent, desired, actual, { key: secret });
        // Before the write: T3 checks a changed instance by starting the same command
        // with the same marker, and stopping one of those would fail its check. A new
        // instance is included because a gateway removed and added back under one name
        // has the same id, and T3 would attach it to whatever was left running.
        if (!actual || stale || rewritten || changed.some(reachesProcess)) await processes.stop(agent.id, instanceId).catch(() => 0);
        await t3.upsert(instanceId, renamed || !actual ? merged : { ...merged, displayName: actual.displayName, accentColor: actual.accentColor });
        if (stamp !== undefined) agents[agent.id] = { ...wanted, keyAt: stamp };
        results.push({ agent: agent.id, ok: true, action: actual ? 'updated' : 'created' });
      } catch (error) {
        results.push({ agent: agent.id, ok: false, action: 'failed', error: String(error?.message ?? error).slice(0, 240) });
      }
    }
    invalidate();
    return { results, agents };
  };

  /** Bring an agent's files up to date. Answers whether a process would need to reread them. */
  const writeAgentFiles = async (agent, gateway, secret, { quiet = false } = {}) => {
    const files = filesFor(agent, gateway, filesDir);
    if (!files) return false;
    const config = await writePrivate(io, files.config, fileText(agent, gateway, filesDir));
    const key = secret === undefined ? false : await writePrivate(io, files.key, secret || NO_KEY);
    return (config && !quiet) || key;
  };
  const removeAgentFiles = async (agent, gateway) => {
    const files = filesFor(agent, gateway, filesDir);
    if (files) await Promise.all(Object.values(files).map(file => io.rm(file, { force: true }).catch(() => {})));
  };

  /** Keep the list T3 shows true: hide what this gateway stopped serving, restore what it serves again. */
  const syncHidden = async (id, agentIds) => {
    const { gateways } = await store.read(), gateway = gateways.find(entry => entry.id === id), state = await readT3({ fresh: true });
    if (!gateway || !state.ok) return;
    const changes = [], hidden = {};
    for (const agent of AGENTS.filter(entry => agentIds.includes(entry.id) && gateway.agents[entry.id]?.on)) {
      const instanceId = instanceIdFor(id, agent), provider = state.providers.find(entry => entry.instanceId === instanceId);
      const hide = modelsToHide(agent, gateway, provider), ours = gateway.agents[agent.id].hidden ?? [];
      const current = new Set(state.preferences?.[instanceId]?.hiddenModels ?? []);
      // Only models hidden here are restored: anyone can hide one in T3 Code too.
      for (const model of hide) if (!current.has(model)) changes.push({ provider: instanceId, model, hidden: true });
      for (const model of ours) if (!hide.includes(model) && current.has(model)) changes.push({ provider: instanceId, model, hidden: false });
      hidden[agent.id] = hide;
    }
    if (changes.length) await t3.setModelsHidden(changes);
    // Only `hidden`, on the newest record: someone may have changed anything else by now.
    await store.update(undefined, rows => rows.map(entry => entry.id !== id ? entry : { ...entry,
      agents: Object.fromEntries(Object.entries(entry.agents).map(([agentId, row]) => [agentId, agentId in hidden ? { ...row, hidden: hidden[agentId] } : row])) }));
  };

  /**
   * Follow agents through their restart, and sync each one's models once it has
   * reported them. Only those are waited for: T3 doesn't check an instance nobody
   * changed. Runs apart from the request, so closing the page doesn't stop it.
   */
  const settle = async (id, agentIds) => {
    const started = new Date(now() - 2000).toISOString(), running = settling.get(id);
    if (running) { for (const agent of agentIds) running.set(agent, started); return; }
    const pending = new Map(agentIds.map(agent => [agent, started]));
    settling.set(id, pending);
    try {
      for (let attempt = 0; attempt < SETTLE_ATTEMPTS && pending.size; attempt++) {
        await wait(SETTLE_DELAY_MS);
        invalidate();
        const state = await readT3({ fresh: true });
        if (!state.ok) return;
        const ready = [...pending].filter(([agentId, since]) => {
          const provider = state.providers.find(entry => entry.instanceId === instanceIdFor(id, agentOf(agentId)));
          return hasStarted(provider) && provider.checkedAt >= since;
        }).map(([agentId]) => agentId);
        if (!ready.length) continue;
        for (const agentId of ready) pending.delete(agentId);
        await serial(() => syncHidden(id, ready)).catch(() => {});
      }
    } finally { settling.delete(id); invalidate(); }
  };

  const applyAndSave = async (gateway, options) => {
    const { results, agents } = await reconcile(gateway, options);
    await store.update(undefined, gateways => gateways.map(entry => entry.id === gateway.id ? { ...entry, agents } : entry));
    const started = results.filter(result => result.ok && result.action !== 'none' && agents[result.agent]?.on).map(result => result.agent);
    if (started.length) void settle(gateway.id, started).catch(() => {});
    return results;
  };

  // --- reading --------------------------------------------------------------

  const agentRow = (gateway, agent, state, vaultKey) => {
    const wanted = gateway.agents[agent.id], instanceId = instanceIdFor(gateway.id, agent), actual = state.instances[instanceId];
    const provider = state.providers.find(entry => entry.instanceId === instanceId);
    const row = { id: agent.id, connected: Boolean(wanted?.on), instanceId, displayName: actual?.displayName ?? `${agent.short} · ${gateway.name}`, scope: wanted?.scope ?? 'compatible',
      models: modelsFor(agent, gateway).length, offered: gateway.check?.protocols?.[agent.protocol] !== 'missing' };
    if (!wanted?.on) return { ...row, state: 'off' };
    if (!state.ok) return { ...row, state: 'unknown' };
    if (!actual) return { ...row, state: 'missing' };
    if (actual.enabled === false) return { ...row, state: 'paused' };
    if (differences(agent, desiredInstance(agent, gateway, { instances: state.instances, dir: filesDir }), actual).some(name => !COSMETIC.has(name))) return { ...row, state: 'drift' };
    if (vaultKey && wanted.keyAt !== vaultKey.changedAt) return { ...row, state: 'key-stale' };
    if (!provider || (settling.get(gateway.id)?.has(agent.id) && !hasStarted(provider))) return { ...row, state: 'starting' };
    if (provider.installed === false) return { ...row, state: 'not-installed' };
    if (provider.status === 'error') return { ...row, state: 'error', detail: String(provider.message ?? '').slice(0, 240) };
    if (provider.status === 'warning') return { ...row, state: 'warning', detail: String(provider.message ?? '').slice(0, 240) };
    return { ...row, state: 'ready' };
  };

  const viewOf = (gateway, state, keys) => {
    const vaultKey = gateway.credentialId ? keys.find(entry => entry.id === gateway.credentialId) ?? null : null;
    const address = parseAddress(gateway.url);
    return {
      id: gateway.id, name: gateway.name, preset: gateway.preset, url: gateway.url, host: address.ok ? address.host : gateway.url, insecure: Boolean(address.ok && address.insecure),
      key: !gateway.credentialId ? { state: 'none' } : !vaultKey ? { state: 'missing', credentialId: gateway.credentialId } : { state: 'saved', credentialId: gateway.credentialId, changedAt: vaultKey.changedAt },
      check: gateway.check ?? null, models: { ids: gateway.models?.ids ?? [], manual: gateway.models?.manual ?? [], at: gateway.models?.at ?? null },
      latest: gateway.latest ?? null, settling: settling.has(gateway.id),
      agents: AGENTS.map(agent => agentRow(gateway, agent, state, vaultKey)), createdAt: gateway.createdAt,
    };
  };

  /** A conflict matters once Claude uses a gateway. The Add sheet shows it before that. */
  const conflictsFor = async gateways => {
    const found = await scanClaudeSettings({ io, home, env }).catch(() => null);
    if (!found) return [];
    const shown = found.file.startsWith(home + path.sep) ? '~' + found.file.slice(home.length) : found.file;
    return [{ ...found, file: shown, active: gateways.some(gateway => gateway.agents.claude?.on) }];
  };

  const status = async () => {
    const [{ gateways, revision }, state, keys] = await Promise.all([store.read(), readT3(), vault.list().catch(() => [])]);
    return {
      ok: true, revision, gateways: gateways.map(gateway => viewOf(gateway, state, keys)), conflicts: await conflictsFor(gateways),
      t3: { available: state.ok, error: state.ok ? null : state.error, code: state.ok ? null : state.code },
      catalog: { presets: PRESETS, agents: AGENTS, unsupported: UNSUPPORTED_AGENTS, protocols: PROTOCOLS }, keys,
    };
  };

  /** What `/status` shows in the sidebar: no network and no T3 call. */
  const summary = async () => {
    const { gateways } = await store.read();
    return { count: gateways.length, attention: gateways.filter(gateway => gateway.check && !gateway.check.ok).map(gateway => ({ id: gateway.id, name: gateway.name, code: gateway.check.code, message: gateway.check.message })) };
  };

  // --- changing -------------------------------------------------------------

  /** The key a request means: one just typed, a Vault credential, or the saved one. */
  const resolveKey = async ({ key, credentialId, gateway }) => {
    const typed = cleanKey(key);
    if (typed) return typed;
    const id = credentialId === undefined ? gateway?.credentialId : credentialId;
    if (!id) return '';
    return vault.read(id).catch(() => { throw new GatewayError(`The key ${id} is no longer in the Vault.`, 409, 'key-missing', { field: 'key' }); });
  };

  const test = async input => {
    if (!object(input)) throw new GatewayError('Enter a gateway address.');
    const { gateways } = await store.read();
    if (typeof input.id === 'string' && input.url === undefined) {
      const gateway = find(gateways, input.id), result = await probe(gateway.url, await keyFor(gateway));
      await store.update(undefined, rows => rows.map(entry => entry.id === gateway.id ? { ...entry, ...observed(entry, result) } : entry));
      return { ok: true, result: { ...result, offers: offersOf(result) } };
    }
    const gateway = typeof input.id === 'string' ? gateways.find(entry => entry.id === input.id) : undefined;
    const { url, notes } = cleanAddress(input.url);
    const result = await probe(url, await resolveKey({ key: input.key, credentialId: input.credentialId, gateway }));
    return { ok: true, result: { ...result, notes, offers: offersOf(result) } };
  };

  const cleanSelection = selection => {
    if (!Array.isArray(selection) || selection.some(id => !agentOf(id))) throw new GatewayError('Choose agents from the list.', 400, 'invalid', { field: 'agents' });
    return [...new Set(selection)];
  };

  const create = input => serial(async () => {
    if (!object(input?.gateway)) throw new GatewayError('Enter a gateway address.');
    const { url } = cleanAddress(input.gateway.url), preset = presetOf(input.gateway.preset) ?? presetOf('custom');
    const name = cleanName(input.gateway.name || suggestName(url, preset.id === 'custom' ? null : preset.name));
    const selection = cleanSelection(input.gateway.agents ?? []), manual = cleanManual(input.gateway.manual), typed = cleanKey(input.key);
    const state = await requireT3(), { gateways, revision } = await store.read();
    if (input.revision !== undefined && input.revision !== revision) throw new GatewayError('Gateways changed in another window. Refresh before adding this one.', 409, 'conflict');
    const key = await resolveKey({ key: typed, credentialId: input.credentialId ?? undefined });
    const result = recentProbe(url, key) ?? await probe(url, key);
    const taken = new Set([...gateways.map(entry => entry.id), ...RESERVED_IDS]), base = slug(name);
    let id = base;
    for (let index = 2; taken.has(id); index++) id = `${base.slice(0, 28).replace(/-+$/, '')}-${index}`;
    const credentialId = typed ? (await vault.create({ id: await vault.available(`${id}-gateway`), name, url, key: typed })).id : input.credentialId ?? null;
    const gateway = { id, name, preset: preset.id, url, credentialId, accent: ACCENTS[gateways.length % ACCENTS.length], createdAt: new Date(now()).toISOString(), check: checkOf(result), latest: null,
      models: { ids: cleanModelIds(result.models.ids), manual, at: result.models.listed ? now() : null },
      agents: Object.fromEntries(selection.map(agent => [agent, { on: true, scope: 'compatible', keyAt: null }])) };
    try { await store.update(revision, rows => [...rows, gateway]); }
    catch (error) { if (typed) await vault.remove(credentialId).catch(() => {}); throw error; }
    const results = await applyAndSave(gateway, { state, key, renamed: true });
    onEvent(`Added the ${name} gateway`);
    return { ok: true, id, results, ...await status() };
  });

  const save = input => serial(async () => {
    if (!object(input?.gateway) || typeof input.id !== 'string') throw new GatewayError('Enter gateway details.');
    const state = await requireT3(), { gateways } = await current(input.revision), previous = find(gateways, input.id);
    const { url } = cleanAddress(input.gateway.url ?? previous.url), name = cleanName(input.gateway.name ?? previous.name), typed = cleanKey(input.key);
    const manual = input.gateway.manual === undefined ? previous.models?.manual ?? [] : cleanManual(input.gateway.manual);
    let credentialId = input.credentialId === undefined ? previous.credentialId : input.credentialId, key;
    if (typed) {
      const held = credentialId && (await vault.list()).some(entry => entry.id === credentialId);
      credentialId = (held ? await vault.replace(credentialId, typed) : await vault.create({ id: await vault.available(`${previous.id}-gateway`), name, url, key: typed })).id;
      key = typed;
    } else if (credentialId !== previous.credentialId) key = await resolveKey({ credentialId: credentialId ?? null });
    const moved = url !== previous.url || key !== undefined;
    const known = key ?? (moved ? await keyFor({ credentialId }) : '');
    const result = moved ? recentProbe(url, known) ?? await probe(url, known) : null;
    const next = { ...previous, name, url, credentialId, ...(result ? observed(previous, result) : {}),
      models: { ...previous.models, manual, ...(result?.ok && result.models.listed ? { ids: cleanModelIds(result.models.ids), at: now() } : {}) } };
    if (result?.ok) next.latest = null;
    await store.update(undefined, rows => rows.map(entry => entry.id === next.id ? next : entry));
    const renamed = name !== previous.name, sameModels = JSON.stringify(manual) === JSON.stringify(previous.models?.manual ?? []);
    const results = await applyAndSave(next, { state, key, renamed, quiet: renamed && !moved && sameModels });
    onEvent(`Changed the ${name} gateway`);
    return { ok: true, results, ...await status() };
  });

  const setAgent = input => serial(async () => {
    const agent = agentOf(input?.agent);
    if (!agent || typeof input.connected !== 'boolean') throw new GatewayError('Choose an agent.');
    if (input.scope !== undefined && !['compatible', 'all'].includes(input.scope)) throw new GatewayError('Choose which models to show.');
    const state = await requireT3(), { gateways } = await current(input.revision), previous = find(gateways, input.id), row = previous.agents[agent.id];
    if (input.connected && !row?.on && previous.check?.protocols?.[agent.protocol] === 'missing') throw new GatewayError(`This gateway has no ${PROTOCOLS[agent.protocol].name} API, which ${agent.name} needs.`, 409, 'unsupported');
    const next = { ...previous, agents: { ...previous.agents, [agent.id]: { ...row, scope: input.scope ?? row?.scope ?? 'compatible', keyAt: row?.keyAt ?? null, on: input.connected } } };
    await store.update(undefined, rows => rows.map(entry => entry.id === next.id ? next : entry));
    const results = await applyAndSave(next, { state });
    // If T3 refused, the agent is still as it was, and the page should say so.
    if (results.some(result => result.agent === agent.id && !result.ok)) await store.update(undefined, rows => rows.map(entry => entry.id !== next.id ? entry : { ...entry, agents: { ...entry.agents, [agent.id]: row ?? { ...next.agents[agent.id], on: false } } }));
    return { ok: true, results, ...await status() };
  });

  /** Restore what was changed in T3 Code, and bring a stale key up to date. */
  const reapply = input => serial(async () => {
    const state = await requireT3(), { gateways } = await current(input?.revision), gateway = find(gateways, input.id);
    const results = await applyAndSave(gateway, { state });
    // Nothing to change, and T3 still reports a problem: have it look again.
    await Promise.all(results.filter(result => result.action === 'none' && gateway.agents[result.agent]?.on).map(result => {
      const instanceId = instanceIdFor(gateway.id, agentOf(result.agent));
      return ['error', 'warning'].includes(state.providers.find(entry => entry.instanceId === instanceId)?.status) ? t3.refresh(instanceId).catch(() => {}) : null;
    }));
    invalidate();
    return { ok: true, results, ...await status() };
  });

  /** Fetch the gateway's list and apply it. The person asked, so this may restart instances. */
  const refreshModels = input => serial(async () => {
    const state = await requireT3(), { gateways } = await current(input?.revision), previous = find(gateways, input.id);
    const result = await probe(previous.url, await keyFor(previous));
    if (!result.ok) {
      await store.update(undefined, rows => rows.map(entry => entry.id === previous.id ? { ...entry, ...observed(entry, result) } : entry));
      return { ok: true, results: [], result, ...await status() };
    }
    const next = { ...previous, check: checkOf(result), latest: null, models: { ...previous.models, ...(result.models.listed ? { ids: cleanModelIds(result.models.ids), at: now() } : {}) } };
    await store.update(undefined, rows => rows.map(entry => entry.id === next.id ? next : entry));
    const results = await applyAndSave(next, { state });
    return { ok: true, results, result, ...await status() };
  });

  const remove = input => serial(async () => {
    const state = await requireT3(), { gateways } = await current(input?.revision), gateway = find(gateways, input.id);
    for (const agent of AGENTS) {
      const instanceId = instanceIdFor(gateway.id, agent);
      // Re-adding this name would otherwise reattach to the process left behind.
      await processes.stop(agent.id, instanceId).catch(() => 0);
      if (state.instances[instanceId]) await t3.remove(instanceId);
      // Even with no instance: one deleted in T3 Code leaves its files, key included.
      await removeAgentFiles(agent, gateway);
    }
    invalidate();
    await store.update(undefined, rows => rows.filter(entry => entry.id !== gateway.id));
    onEvent(`Removed the ${gateway.name} gateway`);
    return { ok: true, ...await status() };
  });

  const clearConflict = input => serial(async () => {
    if (input?.id !== 'claude-settings') throw new GatewayError('Choose a conflict to fix.');
    await clearClaudeSettings({ io, home, env });
    return { ok: true, ...await status() };
  });

  const actions = { '/gateways/test': test, '/gateways/create': create, '/gateways/save': save, '/gateways/agent': setAgent, '/gateways/apply': reapply, '/gateways/models': refreshModels, '/gateways/remove': remove, '/gateways/conflict': clearConflict };
  return { status, summary, test, create, save, setAgent, reapply, refreshModels, remove, clearConflict,
    /** One entry point for the server. `route` is one of GATEWAY_ROUTES. */
    handle: (route, input) => route === '/gateways' ? status() : actions[route]?.(input) ?? Promise.reject(new GatewayError('Gateway action not found.', 404, 'not-found')) };
}

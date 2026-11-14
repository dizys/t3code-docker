// Asks a gateway what it can do, from inside this container, where the agents
// will reach it from.
//
// Nothing here can spend money: the protocol checks post an empty body, which a
// real route rejects as invalid and a missing one answers with 404. Every
// failure ends in a sentence naming what to do next, and an upstream's own
// words are never shown, because an error body can echo the key.
import { PROTOCOLS } from './catalog.mjs';
import { parseAddress, withHost } from './address.mjs';
import { cleanModelLimits, cleanReasoning, parseModelCapabilities, parseModelList } from './models.mjs';
import { gatewayFetch, lookupGateway } from './transport.mjs';

const DOCKER_HOST = 'host.docker.internal';
const MAX_LIST_BYTES = 8 * 1024 * 1024;
// This is the catalog schema version we understand, not an installed agent's
// version. Newer versions advertise max/ultra as well. No inference is sent.
const CATALOG_PATH = '/v1/models?client_version=0.144.0';

// Gateways answer by client. CLIProxyAPI gives anything naming this header its
// Anthropic list, where other vendors' models wear `claude-` names so Claude Code
// keeps them. Only the plain list has real names, and every route takes those.
const ANTHROPIC = { 'anthropic-version': '2023-06-01' };

const headersFor = key => ({
  accept: 'application/json',
  'user-agent': 't3code-docker-setup',
  ...(key ? { authorization: `Bearer ${key}`, 'x-api-key': key } : {}),
});

const CERTIFICATE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/;
const connectionCode = error => {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = String(error?.cause?.code ?? error?.code ?? '');
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA'].includes(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) return 'timeout';
  if (CERTIFICATE.test(code)) return 'tls';
  return 'unreachable';
};

/** The sentence, and any one-press fix, for a failed connection. */
function connectionProblem(code, address) {
  const { url, host, hostname, loopback } = address, onDockerHost = hostname === DOCKER_HOST;
  const problems = {
    dns: onDockerHost
      ? { message: 'This container can’t find host.docker.internal.', hint: 'Add it to your compose file under extra_hosts, as "host.docker.internal:host-gateway", then recreate the container.' }
      : { message: `${hostname} can’t be found from this container.`, hint: 'Check the name. A gateway in another Compose project needs a shared network.' },
    refused: loopback
      ? { message: `Nothing is answering at ${host} inside this container.`, hint: 'This address means the container itself. If the gateway runs on the Docker host, use host.docker.internal.', fix: { url: withHost(url, DOCKER_HOST), label: `Use ${DOCKER_HOST}` } }
      : onDockerHost
        ? { message: `The Docker host isn’t answering at ${host}.`, hint: 'Check that the gateway is running and listening on 0.0.0.0, not only on 127.0.0.1.' }
        : { message: `Nothing is answering at ${host}.`, hint: 'Check that the gateway is running and that the port is right.' },
    timeout: { message: `${host} didn’t answer in time.`, hint: 'A firewall may be dropping the connection, or the gateway is busy.' },
    tls: { message: `The certificate at ${host} isn’t trusted here.`, hint: 'Use a certificate from a public authority, or plain http on a private network.' },
    unreachable: { message: `${host} couldn’t be reached from this container.`, hint: 'Check the address and your network.' },
  };
  return problems[code];
}

export async function readJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_LIST_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

export const discard = response => response.body?.cancel?.().catch(() => {});

/**
 * Which product this is, so the page can offer what it supports. CLIProxyAPI says so
 * at its root, which needs no key. Its management routes would tell more, but each
 * request there without a key counts toward locking this server out.
 */
const identify = async ({ url, hostname }, signal, fetchImpl) => {
  if (hostname === 'openrouter.ai') return 'openrouter';
  try {
    const response = await fetchImpl(`${url}/`, { redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 't3code-docker-setup' }, signal: signal() });
    const body = response.ok ? await readJson(response) : (await discard(response), null);
    return /cli\s*proxy\s*api/i.test(String(body?.message ?? '')) ? 'cliproxyapi' : null;
  } catch { return null; }
};

/** How a route answered an empty body. Anything but "no such route" means it's there. */
const routeState = status => {
  if (status === 401 || status === 403) return 'unauthorized';
  if ([404, 405, 501].includes(status)) return 'missing';
  if (status >= 500) return 'unknown';
  return 'available';
};

/**
 * Probe an address. Never throws: a failure is a result.
 *
 *   { at, ok, code, message, hint, fix, ms, url, notes, insecure, product,
 *     models: { listed, ids, capabilities }, protocols: { messages, responses, chat } }
 *
 * A keyless check of `/` runs first, so an unreachable host never sees a key.
 * A private host needs `{ allowPrivateHost: true }` before any request.
 * Redirects are reported, never followed, so a key never leaves this host.
 */
export async function probeGateway({ url: input, key = '', fetchImpl = globalThis.fetch, timeoutMs = 6000, now = Date.now, signal, allowPrivateHost = false, lookup = lookupGateway } = {}) {
  const at = now(), address = parseAddress(input, { allowPrivateHost });
  if (!address.ok) return { at, ok: false, code: address.code ?? 'invalid', message: address.error, ...(address.code === 'private-host' ? { confirmHost: address.hostname, host: address.host, hint: 'Tick “Private host” to confirm this address is yours, then test again.' } : {}), models: { listed: false, ids: [], capabilities: {} }, protocols: {} };
  const { url, notes, insecure, hostname } = address, headers = headersFor(key), keyless = headersFor(), limit = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const finish = (result) => ({ at, url, notes, insecure, ms: Math.max(0, now() - at), models: { listed: false, ids: [], capabilities: {} }, protocols: {}, ...result });
  const privateRefusal = pinned => finish({ ok: false, code: 'private-host', confirmHost: hostname, host: address.host, message: `“${hostname}” looks like a private host${pinned ? ` (${pinned})` : ''}.`, hint: 'Tick “Private host” to confirm this address is yours, then test again.' });
  const metadataRefusal = pinned => finish({ ok: false, code: 'metadata-host', host: address.host, message: `“${hostname}” is a cloud metadata address${pinned ? ` (${pinned})` : ''}. A gateway can never use it.`, hint: 'Use a gateway address instead.' });
  // DNS is pinned once, before any request: no re-resolve per redirect or per route.
  let fetchPinned;
  try { fetchPinned = await gatewayFetch(address, { allowPrivateHost, lookup, signal: limit(), fetchImpl }); }
  catch (error) {
    if (error.code === 'metadata-host') return metadataRefusal(error.address);
    if (error.code === 'private-host') return privateRefusal(error.address);
    const code = connectionCode(error); return finish({ ok: false, code, ...connectionProblem(code, address) });
  }
  const request = (path, init = {}) => fetchPinned(url + path, { redirect: 'manual', ...init, headers: { ...headers, ...init.headers }, signal: limit() });
  const keylessRequest = (path, init = {}) => fetchPinned(url + path, { redirect: 'manual', ...init, headers: { ...keyless, ...init.headers }, signal: limit() });

  // Keyless first: an unreachable host is reported before any key is sent.
  let probe;
  try { probe = await keylessRequest('/'); }
  catch (error) { const code = connectionCode(error); return finish({ ok: false, code, ...connectionProblem(code, address) }); }
  // A landing-page redirect says nothing about the API routes. Do not follow
  // it, but still test the explicitly entered origin's model endpoint.
  await discard(probe);

  let list;
  try { list = await request('/v1/models'); }
  catch (error) { const code = connectionCode(error); return finish({ ok: false, code, ...connectionProblem(code, address) }); }

  if (list.status >= 300 && list.status < 400) {
    // The key went only to the address typed, never to where it points: redirects aren't followed.
    const location = list.headers?.get?.('location') ?? '';
    await discard(list);
    const target = /^https?:\/\//i.test(location) ? parseAddress(location, { allowPrivateHost }) : null;
    return finish({ ok: false, code: 'redirect', message: `${address.host} redirects somewhere else.`,
      ...(target?.ok ? { hint: `It points to ${target.url}.`, fix: { url: target.url, label: 'Use that address' } } : { hint: 'Use the address it redirects to.' }) });
  }

  // The ids and the reasoning facts ride in the same list entry, so read them
  // from the same body: a second read would see a second response.
  const readModels = async response => {
    const body = response.ok ? await readJson(response) : (await discard(response), null);
    const ids = body === null ? null : parseModelList(body);
    return ids === null ? null : { ids, capabilities: parseModelCapabilities(body) ?? {} };
  };
  let listed = await readModels(list);
  // Anthropic's own API refuses a list without its header.
  if (listed === null && list.status !== 401 && list.status !== 403) listed = await request('/v1/models', { headers: ANTHROPIC }).then(readModels, () => null);
  const models = { listed: listed !== null, ids: listed?.ids ?? [], capabilities: listed?.capabilities ?? {} };
  const product = identify(address, limit, fetchPinned);
  const routes = await Promise.all(Object.values(PROTOCOLS).map(async protocol => {
    try {
      const response = await request(protocol.path, { method: 'POST', headers: { 'content-type': 'application/json', ...(protocol.id === 'messages' ? ANTHROPIC : {}) }, body: '{}' });
      await discard(response);
      return [protocol.id, routeState(response.status)];
    } catch { return [protocol.id, 'unknown']; }
  }));
  const states = Object.fromEntries(routes), values = Object.values(states), known = await product;
  const refused = list.status === 401 || list.status === 403 || values.includes('unauthorized');
  const protocols = Object.fromEntries(routes.map(([id, state]) => [id, state === 'unauthorized' ? 'unknown' : state]));
  if (refused) {
    return finish({ ok: false, code: 'unauthorized', status: list.status, protocols, models,
      message: key ? 'The gateway turned this key down.' : 'This gateway needs a key.',
      hint: key ? 'Check that it’s a key for this gateway and that it’s still active.' : 'Enter one above.' });
  }
  // CLIProxyAPI's ordinary list strips capability metadata. Its Codex-client
  // catalog describes every provider, not just OpenAI. Keep the ordinary ids
  // authoritative when available: catalog templates must never add phantom
  // routes. Failure, redirects, and older servers gracefully retain that list.
  if (known === 'cliproxyapi') {
    try {
      const response = await request(CATALOG_PATH);
      const body = response.ok ? await readJson(response) : (await discard(response), null);
      if (Array.isArray(body?.models)) {
        const ids = parseModelList(body), capabilities = parseModelCapabilities(body) ?? {};
        if (!models.listed) { models.ids = ids; models.listed = true; }
        for (const id of models.ids) if (Object.hasOwn(capabilities, id)) {
          // The ordinary list can describe reasoning without any token limits.
          // Fill missing facts independently, keeping its explicit facts first.
          const ordinary = models.capabilities[id], catalog = capabilities[id];
          const reasoning = cleanReasoning(ordinary) ?? cleanReasoning(catalog);
          const limits = cleanModelLimits({ ...catalog.limits, ...ordinary?.limits });
          models.capabilities[id] = { ...reasoning, ...(limits ? { limits } : {}) };
        }
      }
    } catch { /* The optional catalog must not break an otherwise working gateway. */ }
  }
  if (!values.includes('available') && !models.listed) {
    const notJson = list.ok;
    return finish({ ok: false, code: 'not-gateway', status: list.status, protocols, models,
      message: notJson ? `${address.host} answered, but not like an AI gateway.` : `${address.host} has no AI API at this address.`,
      hint: 'Check the address, including any path such as /api.' });
  }
  return finish({ ok: true, code: 'ok', status: list.status, protocols, models, product: known });
}

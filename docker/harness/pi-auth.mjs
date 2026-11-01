// Pi's saved sign-ins: one contract for the harness probe, Setup's key sheet
// and diagnostics.
//
// Pi keeps one credential per provider in <agent dir>/auth.json: an API key
// ({"type":"api_key","key":"..."}) or a subscription sign-in made with /login
// ({"type":"oauth",...}). Pi has no command that saves a key, so Setup writes
// the file itself. Pi takes a proper-lockfile lock (`auth.json.lock`, a
// directory) for every write, including OAuth refreshes; Setup takes the
// same lock, so neither can lose the other's change.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';

const MAX_FILE = 1024 * 1024;
// Pi treats a lock older than this as abandoned. A live holder refreshes it
// at half this age, so an older lock is never someone's write in progress.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

import { PI_KEY_PROVIDERS, PI_SUBSCRIPTION_ONLY } from './pi-providers.mjs';
export { PI_KEY_PROVIDERS, PI_SUBSCRIPTION_ONLY, PI_CREDENTIAL_ENV } from './pi-providers.mjs';

const NAMES = new Map([...PI_KEY_PROVIDERS, ...PI_SUBSCRIPTION_ONLY].map((provider) => [provider.id, provider.name]));
/** A provider's display name; ids Pi adds later read as themselves. */
export const piProviderName = (id) => NAMES.get(id) || id;

// Pi's own ids are lower-case; custom providers from models.json can be
// anything a JSON key can be, within reason.
export const isPiProviderId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);

/** Pi's agent directory: PI_CODING_AGENT_DIR (with ~ expanded) or ~/.pi/agent. */
export function piAgentDir(home, env = {}) {
  const value = String(env.PI_CODING_AGENT_DIR ?? '').trim();
  if (!value) return path.join(home, '.pi', 'agent');
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return path.resolve(home, value);
}
export const piAuthFile = (home, env) => path.join(piAgentDir(home, env), 'auth.json');

/** Providers with a credential in the environment, as Pi would find them. */
export function piEnvCredentials(env = {}) {
  const found = [];
  for (const provider of [...PI_KEY_PROVIDERS, ...PI_SUBSCRIPTION_ONLY]) {
    const variable = provider.env.find((name) => typeof env[name] === 'string' && env[name].trim());
    if (variable) found.push({ provider: provider.id, variable });
  }
  return found;
}

/** Saved credentials without their secrets: provider and kind only. */
export function piSavedCredentials(auth) {
  return Object.entries(auth).map(([provider, credential]) => ({
    provider, type: credential?.type === 'oauth' ? 'oauth' : 'api_key',
  })).sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * `pi --list-models` prints a table of the models Pi can use now, which only
 * includes providers it holds credentials for (saved, environment, models.json
 * or extensions). That is also how T3 Code decides Pi is ready. An empty list
 * means no sign-in; anything unrecognisable is no verdict at all.
 */
export function parsePiModelList(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.some((line) => /^\s*No models available\b/i.test(line))) return { available: false, providers: [] };
  const header = lines.findIndex((line) => /^\s*provider\s+model\b/i.test(line));
  if (header < 0) return { available: null, providers: [] };
  const providers = new Set();
  for (const line of lines.slice(header + 1)) {
    const provider = /^\s*(\S+)\s+\S/.exec(line)?.[1];
    if (provider && isPiProviderId(provider)) providers.add(provider);
  }
  return providers.size ? { available: true, providers: [...providers].sort() } : { available: null, providers: [] };
}

/** Read auth.json without following it anywhere odd or loading something huge. */
export async function readPiAuth({ home, env, io = fs }) {
  const file = piAuthFile(home, env);
  let text;
  try {
    const handle = await io.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error(), { code: 'EINVAL' });
      if (stat.size > MAX_FILE) throw Object.assign(new Error(), { code: 'E2BIG' });
      text = await handle.readFile('utf8');
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error.code === 'E2BIG') throw new Error('Pi’s auth.json is too large to read.');
    throw new Error('Pi’s saved sign-ins could not be read.');
  }
  if (Buffer.byteLength(text) > MAX_FILE) throw new Error('Pi’s auth.json is too large to read.');
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text.replace(/^﻿/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    for (const credential of Object.values(value)) {
      if (!credential || typeof credential !== 'object' || Array.isArray(credential)) throw new Error();
    }
    return value;
  } catch {
    throw new Error('Pi’s auth.json is not valid. Repair it, or sign in again with /login in Pi, before changing keys here.');
  }
}

// proper-lockfile's lock: a directory beside the file, made atomically.
async function withPiLock(io, file, work, { now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const lock = file + '.lock';
  const deadline = now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try { await io.mkdir(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Pi’s saved sign-ins could not be locked for writing.');
      let stale = false;
      try { stale = now() - (await io.stat(lock)).mtimeMs > LOCK_STALE_MS; } catch (statError) { if (statError.code === 'ENOENT') continue; }
      if (stale) { await io.rm(lock, { recursive: true, force: true }).catch(() => {}); continue; }
      if (now() >= deadline) throw new Error('Pi is saving its sign-ins right now. Try again in a moment.');
      await wait(Math.min(25 * 2 ** attempt, 250));
    }
  }
  try { return await work(); }
  finally { await io.rm(lock, { recursive: true, force: true }).catch(() => {}); }
}

// Replace auth.json in one step, through a link to wherever it really lives.
async function writePiAuth(io, file, value) {
  let target = file, entry = null;
  try { entry = await io.lstat(file); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Pi’s auth.json could not be checked before writing.');
  }
  if (entry?.isSymbolicLink()) {
    // A link to nothing has no file to replace; refuse rather than guess.
    try { target = await io.realpath(file); } catch { throw new Error('Pi’s auth.json links to a missing file. Fix the link first.'); }
  }
  const temporary = path.join(path.dirname(target), '.auth.json.' + randomBytes(8).toString('hex') + '.tmp');
  try {
    await io.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await io.rename(temporary, target);
  } finally { await io.rm(temporary, { force: true }).catch(() => {}); }
}

/**
 * Save and remove Pi credentials. Every change is a locked
 * read-modify-write, so other providers, subscription sign-ins and Pi's own
 * token refreshes stay as they are.
 */
export function createPiAuth({ home, env = {}, io = fs, onChange = async () => {}, lockOptions } = {}) {
  let pending = Promise.resolve();
  const serial = (work) => { const current = pending.then(work); pending = current.catch(() => {}); return current; };
  const file = () => piAuthFile(home, env);
  const change = (mutate) => serial(async () => {
    const target = file();
    await io.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      return await withPiLock(io, target, async () => {
        const auth = await readPiAuth({ home, env, io });
        const { result, next } = mutate(auth);
        if (next) await writePiAuth(io, target, next);
        return result;
      }, lockOptions);
    } finally { await onChange(); }
  });
  const validate = (provider) => { if (!isPiProviderId(provider)) throw new Error('Choose a provider (for example anthropic, openai or openrouter).'); };
  return {
    file,
    async list() {
      return { saved: piSavedCredentials(await readPiAuth({ home, env, io })), env: piEnvCredentials(env) };
    },
    async saveKey(provider, key, { replaceSubscription = false } = {}) {
      validate(provider);
      if (typeof key !== 'string' || !key.trim() || key.trim().length > 1000) throw new Error('Enter a key of at most 1000 characters.');
      const value = key.trim();
      // Pi runs a value starting with ! as a shell command and expands $NAME.
      if (value.startsWith('!') || value.includes('$')) throw new Error('Pi reads a key that starts with ! or contains $ as a command or variable. Enter the key itself.');
      if (/\s/.test(value)) throw new Error('A key has no spaces or line breaks. Check what was pasted.');
      return change((auth) => {
        const current = auth[provider];
        if (current?.type === 'oauth' && !replaceSubscription) {
          throw Object.assign(new Error(`Pi is signed in to ${piProviderName(provider)} with a subscription. Saving a key replaces that sign-in.`), { code: 'subscription-exists' });
        }
        // Keep extra settings saved with an earlier key, such as account ids.
        const extra = current?.type === 'api_key' && current.env && typeof current.env === 'object' ? { env: current.env } : {};
        return { result: { ok: true, replaced: current ? current.type : null }, next: { ...auth, [provider]: { type: 'api_key', key: value, ...extra } } };
      });
    },
    async removeProvider(provider) {
      validate(provider);
      return change((auth) => {
        if (!Object.hasOwn(auth, provider)) return { result: { ok: true, removed: false }, next: null };
        const next = { ...auth };
        delete next[provider];
        return { result: { ok: true, removed: true }, next };
      });
    },
  };
}

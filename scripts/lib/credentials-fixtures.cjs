// Synthetic, in-memory credentials. No connection or secret leaves this fixture.
const { randomBytes } = require('node:crypto');
const { fixture, shiftTimes } = require('./console-fixtures.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const revision = () => randomBytes(8).toString('hex');
// Enough of the real detection for the paste box in a preview.
const detectFixture = text => {
  const value = String(text || '').trim();
  if (/^-----BEGIN/.test(value)) return { type: 'ssh', label: 'an SSH private key', id: '', fields: { auth: 'key' }, secrets: { privateKey: value }, env: {}, confident: true };
  if (/^gh[pousr]_/.test(value)) return { type: 'git', label: 'a GitHub token', id: 'github', fields: { host: 'github.com', username: 'x-access-token', baseUrl: 'https://api.github.com/', authType: 'bearer', testPath: 'user' }, secrets: { token: value }, env: { token: 'GH_TOKEN' }, confident: true };
  if (/^postgres(ql)?:\/\//.test(value)) return { type: 'database', label: 'a PostgreSQL connection URL', id: 'app-db', fields: { engine: 'postgres', host: 'db.example.net', database: 'app', username: 'app' }, secrets: { password: 'fixture' }, env: {}, confident: true };
  return value ? { type: 'token', label: 'a token', id: '', fields: {}, secrets: { token: value }, env: {}, confident: false } : null;
};
function createCredentialsFixtures() {
  const data = shiftTimes(fixture('credentials.json'), Date.now() - Date.parse('2026-10-30T22:00:00Z'));
  const key = { type: 'ssh-ed25519', fingerprint: data.credentials.find(row => row.id === 'build-server').hostKey.fingerprint };
  const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyForTheFixtureOnly0000000000000 t3-vault';
  const now = () => new Date().toISOString();
  const find = id => data.credentials.find(row => row.id === id);
  const untrusted = row => row.type === 'ssh' && row.fields?.auth === 'password' && !row.hostKey;
  const status = () => ({ count: data.credentials.length, attention: data.credentials.filter(row => untrusted(row) || row.test?.ok === false).map(row => ({ id: row.id, code: untrusted(row) ? 'host-key-untrusted' : row.test.code })) });
  const body = value => ({ body: { ok: true, ...clone(value) } });
  const fail = (code, error, extra = {}) => ({ status: 409, body: { ok: false, code, error, ...clone(extra) } });
  const scan = profile => {
    const presented = profile.test?.code === 'host-key-changed' ? profile.test.detail.presented : key;
    return { state: !profile.hostKey ? 'new' : profile.hostKey.fingerprint === presented.fingerprint ? 'trusted' : 'changed', presented, ...(profile.hostKey ? { trusted: { type: profile.hostKey.type, fingerprint: profile.hostKey.fingerprint } } : {}) };
  };
  const respond = async (method, url, input = {}) => {
    const route = url.pathname.replace(/^\/__setup/, '');
    if (!/^\/credentials(?:\/|$)/.test(route)) return null;
    if (method === 'GET' && route === '/credentials') return body({ ...data, usageAt: now() });
    if (route.endsWith('/generate-key')) return body({ keyId: 'fixture-key', publicKey, install: 'fixture' });
    if (route.endsWith('/detect')) return body({ detected: detectFixture(input.text) });
    const profile = find(input.id || input.credential?.id);
    if (route.endsWith('/create') || route.endsWith('/save')) {
      if (route.endsWith('/create') && profile) return fail('taken', 'That name is already taken.');
      if (route.endsWith('/save') && !profile) return fail('gone', 'This credential was deleted elsewhere.');
      if (profile && input.revision !== profile.revision) return fail('changed', 'This credential changed elsewhere.', { current: profile });
      const { secrets = {}, ...visible } = input.credential, changedSecret = Object.values(secrets).some(Boolean);
      const next = { ...profile, ...visible, fields: { ...visible.fields, ...(input.generatedKeyId || input.generate ? { publicKey } : {}) }, secretNames: [...new Set([...(profile?.secretNames || []), ...Object.keys(secrets), ...(input.generatedKeyId || input.generate ? ['privateKey'] : [])])], delivers: profile?.delivers || [], env: { ...profile?.env, ...visible.env }, revision: revision(), hasSecret: true, createdAt: profile?.createdAt || now(), updatedAt: now(), secretChangedAt: changedSecret ? now() : profile?.secretChangedAt || now(), test: null, usedIn: profile?.usedIn || [], hostKey: profile?.host === visible.host && profile?.port === visible.port ? profile.hostKey : null };
      if (input.trust?.fingerprint === key.fingerprint) next.hostKey = { ...key, trustedAt: now(), carried: false };
      data.credentials = [...data.credentials.filter(row => row.id !== next.id), next]; return body({ credential: next });
    }
    if ((route.endsWith('/scan') || route.endsWith('/trust')) && input.id) {
      if (!profile) return fail('gone', 'This credential is no longer saved.');
      if (input.revision !== undefined && input.revision !== profile.revision) return fail('changed', 'This credential changed elsewhere.', { current: profile });
    }
    if (route.endsWith('/scan')) return body({ hostKey: scan(profile || input) });
    if (route.endsWith('/test')) {
      const target = input.draft ? { ...profile, ...input.draft } : profile;
      if (!target) return fail('gone', 'This credential is no longer saved.');
      const hostKey = target.type === 'ssh' ? scan(target) : null;
      const firstUse = hostKey?.state === 'new' && target.fields?.auth === 'key';
      const result = firstUse ? { ok: true, code: 'ok', detail: { user: target.fields.username }, hostKey } : hostKey && hostKey.state !== 'trusted' && input.trust?.fingerprint !== hostKey.presented.fingerprint
        ? { ok: false, code: hostKey.state === 'changed' ? 'host-key-changed' : 'host-key-untrusted', detail: hostKey.trusted ? { trusted: hostKey.trusted, presented: hostKey.presented } : {}, hostKey }
        : target.id === 'home-assistant' ? { ok: false, code: 'rejected', detail: { status: 401 } } : { ok: true, code: 'ok', detail: target.type === 'ssh' ? { user: target.fields?.username } : { status: 200 } };
      Object.assign(result, { ms: 184, at: now() }); if (!input.draft) profile.test = result;
      return body({ result });
    }
    if (!profile) return fail('gone', 'This credential is no longer saved.');
    if (route.endsWith('/trust')) {
      const scanned = scan(profile);
      if (input.fingerprint !== scanned.presented.fingerprint) return fail('key-changed', 'The server presented a different key.', { presented: scanned.presented });
      profile.hostKey = { ...scanned.presented, trustedAt: now(), carried: false }; profile.test = null; return body({ hostKey: profile.hostKey });
    }
    if (route.endsWith('/forget-host-key')) { profile.hostKey = null; profile.test = null; return body({}); }
    if (route.endsWith('/remove')) {
      if (input.revision !== profile.revision) return fail('changed', 'This credential changed elsewhere.', { current: profile });
      data.credentials = data.credentials.filter(row => row !== profile); return body({});
    }
    return { status: 404, body: { ok: false, error: 'Unknown fixture credential action.' } };
  };
  return { respond, status };
}
module.exports = { createCredentialsFixtures };

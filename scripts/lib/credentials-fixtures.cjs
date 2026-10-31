// Synthetic, in-memory credentials. No connection or secret leaves this fixture.
const { randomBytes } = require('node:crypto');
const { fixture, shiftTimes } = require('./console-fixtures.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const revision = () => randomBytes(8).toString('hex');
function createCredentialsFixtures() {
  const data = shiftTimes(fixture('credentials.json'), Date.now() - Date.parse('2026-10-30T22:00:00Z'));
  const key = { type: 'ssh-ed25519', fingerprint: data.credentials.find(row => row.id === 'build-server').hostKey.fingerprint };
  const now = () => new Date().toISOString();
  const find = id => data.credentials.find(row => row.id === id);
  const status = () => ({ count: data.credentials.length, attention: data.credentials.filter(row => row.type === 'ssh' && !row.hostKey || row.test?.ok === false).map(row => ({ id: row.id, code: row.type === 'ssh' && !row.hostKey ? 'host-key-untrusted' : row.test.code })) });
  const body = value => ({ body: { ok: true, ...clone(value) } });
  const fail = (code, error, extra = {}) => ({ status: 409, body: { ok: false, code, error, ...clone(extra) } });
  const scan = profile => {
    const presented = profile.id === 'staging-server' && profile.test?.code === 'host-key-changed' ? profile.test.detail.presented : key;
    return { state: !profile.hostKey ? 'new' : profile.hostKey.fingerprint === presented.fingerprint ? 'trusted' : 'changed', presented, ...(profile.hostKey ? { trusted: { type: profile.hostKey.type, fingerprint: profile.hostKey.fingerprint } } : {}) };
  };
  const respond = async (method, url, input = {}) => {
    const route = url.pathname.replace(/^\/__setup/, '');
    if (!/^\/credentials(?:\/|$)/.test(route)) return null;
    if (method === 'GET' && route === '/credentials') return body({ ...data, usageAt: now() });
    const profile = find(input.id || input.credential?.id);
    if (route.endsWith('/create') || route.endsWith('/save')) {
      if (route.endsWith('/create') && profile) return fail('taken', 'That name is already taken.');
      if (route.endsWith('/save') && !profile) return fail('gone', 'This credential was deleted elsewhere.');
      if (profile && input.revision !== profile.revision) return fail('changed', 'This credential changed elsewhere.', { current: profile });
      const { secret: _secret, ...visible } = input.credential;
      const next = { ...profile, ...visible, revision: revision(), hasSecret: true, createdAt: profile?.createdAt || now(), updatedAt: now(), secretChangedAt: input.credential.secret ? now() : profile?.secretChangedAt || now(), test: null, usedIn: profile?.usedIn || [], hostKey: profile?.host === visible.host && profile?.port === visible.port ? profile.hostKey : null };
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
      const result = hostKey && hostKey.state !== 'trusted' && input.trust?.fingerprint !== hostKey.presented.fingerprint
        ? { ok: false, code: hostKey.state === 'changed' ? 'host-key-changed' : 'host-key-untrusted', detail: hostKey.trusted ? { trusted: hostKey.trusted, presented: hostKey.presented } : {}, hostKey }
        : target.id === 'home-assistant' ? { ok: false, code: 'rejected', detail: { status: 401 } } : { ok: true, code: 'ok', detail: target.type === 'ssh' ? { user: target.username } : { status: 200 } };
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

// Pure credential presentation and draft validation. Saved secrets never enter
// this model; request previews and snippets use fixed masks or placeholders.
const T3CredentialModel = (() => {
  'use strict';
  const M = T3Model, C = T3McpCommand;
  const fields = ['id', 'type', 'host', 'port', 'username', 'baseUrl', 'authType', 'authName', 'authPrefix', 'testPath'];
  const validName = value => typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
  const text = (value, max, optional = false) => typeof value === 'string' && value.isWellFormed() && (optional || value.length > 0) && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  const defaults = type => ({ id: '', type, host: '', port: 22, username: '', baseUrl: '', authType: 'bearer', authName: 'X-API-Key', authPrefix: '', testPath: '' });
  const draftOf = profile => ({ ...defaults(profile?.type || 'ssh'), ...Object.fromEntries(fields.filter(field => profile?.[field] !== undefined).map(field => [field, profile[field]])) });
  const payload = draft => Object.fromEntries(fields.filter(field => draft[field] !== undefined).map(field => [field, field === 'port' ? Number(draft[field]) : draft[field]]));
  const kind = profile => profile.type === 'ssh' ? 'Password' : profile.authType === 'header' ? profile.authName || 'Header key' : profile.authType === 'query' ? '?' + (profile.authName || 'key') : 'Bearer token';
  const secretKind = profile => profile.type === 'ssh' ? 'password' : profile.authType === 'bearer' ? 'token' : 'key';
  const auth = profile => profile.type === 'ssh' ? 'password' : profile.authType === 'header' ? (profile.authName || 'Header') + ' header' : profile.authType === 'query' ? (profile.authName || 'key') + ' query parameter' : 'bearer token';
  const target = profile => profile.type === 'ssh' ? (profile.username || 'user') + '@' + (profile.host || 'host') + (Number(profile.port || 22) !== 22 ? ':' + profile.port : '') : profile.baseUrl;
  const usageCount = (profile, partial = false) => { const n = profile.usedIn?.length || 0, unit = profile.usedIn?.some(item => item.kind === 'instructions') ? 'source' : 'skill'; return partial ? n ? 'At least ' + M.plural(n, unit) : 'Unknown' : M.plural(n, unit); };
  const day = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'unknown'; };
  const keyType = type => type === 'ssh-ed25519' ? 'ED25519' : type === 'ssh-rsa' ? 'RSA' : type?.startsWith('ecdsa') ? 'ECDSA' : 'Host key';
  const keyCommand = type => 'ssh-keygen -lf /etc/ssh/ssh_host_' + (type === 'ssh-rsa' ? 'rsa' : type?.startsWith('ecdsa') ? 'ecdsa' : 'ed25519') + '_key.pub';
  const commands = (profile, editing = false) => profile.type === 'ssh'
    ? ['t3-ssh ' + (profile.id || 'name') + ' -- ' + (editing ? 'command' : 'uptime'), 't3-ssh ' + (profile.id || 'name') + ' -- bash -s < script.sh']
    : ['t3-api ' + (profile.id || 'name') + ' GET ' + C.quote(profile.testPath || '<path>'), 't3-api ' + (profile.id || 'name') + ' POST <path> --stdin < body.json'];
  const snippet = profile => {
    if (profile.type === 'ssh') return `Run commands on ${profile.id} with its saved login:\n\nt3-ssh ${profile.id} -- '<command>'\n\nDon’t read or print credential files.`;
    let host = profile.baseUrl; try { host = new URL(profile.baseUrl).host; } catch {}
    return `Call ${host}’s API with its saved key:\n\nt3-api ${profile.id} GET <path>\nt3-api ${profile.id} POST <path> --stdin < body.json\n\nPaths are relative to ${profile.baseUrl}. Don’t read or print credential files.`;
  };
  const request = (profile, short = false) => {
    try {
      const base = new URL(profile.baseUrl); if (!base.pathname.endsWith('/')) base.pathname += '/';
      const url = new URL(profile.testPath || '.', base);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || url.origin !== base.origin || !url.pathname.startsWith(base.pathname.endsWith('/') ? base.pathname : base.pathname + '/')) return 'Enter a valid base URL and relative test path.';
      if (profile.authType === 'query') url.searchParams.set(profile.authName || 'key', '••••••••');
      const address = (short ? url.pathname + url.search : url.href).replace(/%E2%80%A2/gi, '•');
      const header = profile.authType === 'query' ? '' : profile.authType === 'header' ? (profile.authName || 'X-API-Key') + ': ' + (profile.authPrefix ? profile.authPrefix + ' ' : '') + '••••••••\n' : 'Authorization: Bearer ••••••••\n';
      return 'GET ' + address + '\n' + (short ? 'Host: ' + base.host + '\n' : '') + header + 'accept: application/json';
    } catch { return 'Enter a base URL to preview the request.'; }
  };
  const validate = (draft, { editing = false, names = [], secret = '', hasSecret = false } = {}) => {
    const errors = {};
    if (!validName(draft.id)) errors.id = 'Use up to 64 lowercase letters, numbers and single hyphens.';
    else if (!editing && names.includes(draft.id)) errors.id = draft.id + ' is taken.';
    if (!['ssh', 'api'].includes(draft.type)) errors.type = 'Choose SSH server or HTTP API.';
    if (draft.type === 'ssh') {
      const host = draft.host || ''; let ipv6 = false;
      if (host.includes(':')) { try { const [address, zone, extra] = host.split('%'); const addressUrl = 'http://[' + address + ']/'; ipv6 = new URL(addressUrl).hostname.startsWith('[') && extra === undefined && (zone === undefined || /^[a-z0-9_.-]+$/i.test(zone)); } catch {} }
      if (!text(host, 253) || !(ipv6 || /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))) errors.host = 'Enter a hostname or IP address, without a username or port.';
      if (!Number.isInteger(Number(draft.port)) || Number(draft.port) < 1 || Number(draft.port) > 65535) errors.port = 'Use a port from 1 to 65535.';
      if (!text(draft.username || '', 64) || !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(draft.username)) errors.username = 'Enter a valid SSH username.';
    } else if (draft.type === 'api') {
      let base;
      try { base = new URL(draft.baseUrl); } catch {}
      if (!text(draft.baseUrl || '', 2048) || !base || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) errors.baseUrl = 'Use an HTTP or HTTPS address without credentials, a query or a fragment.';
      if (!['bearer', 'header', 'query'].includes(draft.authType)) errors.authType = 'Choose an authentication method.';
      if (draft.authType !== 'bearer') {
        if (!text(draft.authName || '', 128)) errors.authName = 'Enter an authentication header or parameter name.';
        if (draft.authType === 'header') {
          if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(draft.authName || '') || ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'expect', 'trailer', 'te', 'accept', 'content-type'].includes(draft.authName?.toLowerCase())) errors.authName = 'Use a valid authentication header, such as X-API-Key.';
          if (typeof draft.authPrefix !== 'string' || draft.authPrefix.length > 128 || /[^\x20-\x7e]/.test(draft.authPrefix)) errors.authPrefix = 'Use up to 128 printable characters for the prefix.';
        }
      }
      const relative = draft.testPath || '';
      if (!text(relative, 2048, true) || relative.startsWith('/') || relative.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(relative)) errors.testPath = 'Use a relative path, such as account.';
      else if (base && !errors.baseUrl) {
        if (!base.pathname.endsWith('/')) base.pathname += '/';
        const target = new URL(relative || '.', base);
        if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.hash) errors.testPath = 'The test path must stay under the base URL.';
      }
    }
    if (secret ? !text(secret, 8192) : !hasSecret) errors.secret = 'Enter a ' + secretKind(draft) + ', up to 8192 characters without line breaks.';
    return errors;
  };
  const changes = (previous, current) => fields.filter(field => field !== 'id' && field !== 'type' && String(previous?.[field] ?? '') !== String(current?.[field] ?? ''));
  const fieldLabel = field => ({ host: 'Host', port: 'Port', username: 'Username', baseUrl: 'Base URL', authType: 'Authentication', authName: 'Authentication name', authPrefix: 'Prefix', testPath: 'Test path' }[field] || field);
  const matches = (profile, query) => !query.trim() || [profile.id, profile.host, profile.username, profile.baseUrl, kind(profile), auth(profile), profile.type].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase());
  const needsAttention = (profile, attention) => profile.type === 'ssh' && (!profile.hostKey || profile.test?.code === 'host-key-changed') || profile.test?.ok === false && (profile.test.code !== 'timeout' || attention?.some(row => row.id === profile.id));
  return { fields, validName, defaults, draftOf, payload, kind, secretKind, auth, target, usageCount, day, keyType, keyCommand, commands, snippet, request, validate, changes, fieldLabel, matches, needsAttention, state: M.credentialState };
})();

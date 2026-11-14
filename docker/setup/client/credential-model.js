// Pure credential presentation and draft validation. Saved secrets never enter
// this model; request previews and snippets use fixed masks or placeholders.
// What each type holds comes from the server, so this file has no list of types.
const T3CredentialModel = (() => {
  'use strict';
  const M = T3Model, C = T3McpCommand;
  let TYPES = new Map();
  const setTypes = list => { if (Array.isArray(list)) TYPES = new Map(list.map(type => [type.id, type])); };
  const typeOf = id => TYPES.get(id) || null;
  const typeList = () => [...TYPES.values()];
  const iconFor = id => typeOf(id)?.icon || 'key-round';
  const badge = id => typeOf(id)?.badge || 'Credential';
  const typeLabel = id => typeOf(id)?.label || 'Credential';

  const validName = value => typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value !== 'new';
  const text = (value, max, optional = false) => typeof value === 'string' && value.isWellFormed() && (optional || value.length > 0) && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  const validHost = host => {
    if (!text(host, 253)) return false;
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) return true;
    if (!host.includes(':')) return false;
    try { const [address, zone, extra] = host.split('%'), probe = 'http://[' + address + ']/'; return new URL(probe).hostname.startsWith('[') && extra === undefined && (zone === undefined || /^[a-z0-9_.-]+$/i.test(zone)); } catch { return false; }
  };
  const validEnvName = value => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value || '') && !/^(?:PATH|HOME|USER|SHELL|PWD|IFS|LD_.*|DYLD_.*|NODE_OPTIONS|BASH_ENV|ENV)$/.test(value);

  const applies = (entry, fields) => (!entry.needs || Boolean(fields[entry.needs])) && (!entry.when || Object.entries(entry.when).every(([key, values]) => values.includes(fields[key])));
  const withDefaults = (type, fields = {}) => {
    const result = { ...fields };
    for (const entry of typeOf(type)?.fields || []) if (result[entry.key] === undefined && entry.default !== undefined) result[entry.key] = entry.default;
    return result;
  };
  const primarySecret = (type, fields = {}) => (typeOf(type)?.secrets || []).find(entry => entry.primary && applies(entry, fields)) || null;
  const envStem = id => (id || 'NAME').toUpperCase().replace(/-/g, '_');
  const resolveEnvName = (template, id) => {
    if (!template.includes('{NAME}')) return template;
    const stem = envStem(id), suffix = template.replace('{NAME}_', '');
    return stem === suffix || stem.endsWith('_' + suffix) ? stem : template.replace('{NAME}', stem);
  };
  // The variable an entry reaches commands under, for a draft that may have no name yet.
  const envFor = (draft, entry) => draft.env?.[entry.key] || (entry.env ? resolveEnvName(entry.env, draft.id) : null);

  const defaults = type => ({ id: '', type, description: '', fields: withDefaults(type, {}), env: {}, vars: typeOf(type)?.dynamic ? [{ name: '', value: '', secret: true }] : [] });
  const draftOf = credential => {
    if (!credential) return defaults('token');
    const draft = { ...defaults(credential.type), id: credential.id, description: credential.description || '', fields: withDefaults(credential.type, credential.fields), env: {} };
    for (const entry of [...(typeOf(credential.type)?.fields || []), ...(typeOf(credential.type)?.secrets || [])]) if (entry.editableEnv && credential.env?.[entry.key]) draft.env[entry.key] = credential.env[entry.key];
    if (typeOf(credential.type)?.dynamic) draft.vars = [...Object.entries(credential.fields || {}).map(([name, value]) => ({ name, value, secret: false })), ...(credential.secretNames || []).map(name => ({ name, value: '', secret: true, saved: true }))];
    return draft;
  };
  const payload = (draft, secrets = {}) => {
    const type = typeOf(draft.type), base = { id: draft.id, type: draft.type, description: draft.description || '' };
    if (type?.dynamic) {
      const rows = draft.vars.filter(row => row.name);
      return { ...base, fields: Object.fromEntries(rows.filter(row => !row.secret).map(row => [row.name, row.value])), secretNames: rows.filter(row => row.secret).map(row => row.name), secrets: Object.fromEntries(rows.filter(row => row.secret && row.value).map(row => [row.name, row.value])) };
    }
    const fields = {};
    for (const entry of type?.fields || []) {
      if (entry.key === 'publicKey' || !applies(entry, draft.fields)) continue;
      const value = draft.fields[entry.key];
      if (value !== undefined && value !== '') fields[entry.key] = entry.kind === 'number' ? Number(value) : value;
    }
    return { ...base, fields, env: draft.env || {}, secrets: Object.fromEntries(Object.entries(secrets).filter(([, value]) => value || value === null)) };
  };

  const kind = credential => credential.type === 'ssh' ? (credential.fields?.auth === 'key' ? 'Key' : 'Password') : credential.fields?.baseUrl ? (credential.fields.authType === 'header' ? credential.fields.authName || 'Header key' : credential.fields.authType === 'query' ? '?' + (credential.fields.authName || 'key') : 'Bearer token') : null;
  const secretKind = credential => primarySecret(credential.type, credential.fields)?.label.toLowerCase() || 'secret';
  const host = url => { try { return new URL(url).host; } catch { return url || ''; } };
  const target = credential => {
    const fields = credential.fields || {}, names = credential.delivers || [];
    if (credential.type === 'ssh') return (fields.username || 'user') + '@' + (fields.host || 'host') + (Number(fields.port || 22) !== 22 ? ':' + fields.port : '');
    if (credential.type === 'database') return (fields.username ? fields.username + '@' : '') + (fields.host || '') + (fields.database ? '/' + fields.database : '');
    if (credential.type === 'aws') return (fields.accessKeyId ? fields.accessKeyId.slice(0, 4) + '…' + fields.accessKeyId.slice(-4) : '') + (fields.region ? ' · ' + fields.region : '');
    if (credential.type === 'gcp') return fields.clientEmail || fields.project || names.join(', ');
    const envName = credential.env?.token || credential.env?.password || credential.env?.content || names[0] || '';
    if (fields.baseUrl) return envName + ' · ' + host(fields.baseUrl);
    if (credential.type === 'git') return envName + ' · ' + (fields.host || '');
    return credential.type === 'custom' ? names.slice(0, 4).join(', ') + (names.length > 4 ? ' and ' + (names.length - 4) + ' more' : '') : names.join(', ');
  };
  const delivery = credential => {
    const files = (typeOf(credential.type)?.secrets || []).some(entry => entry.file);
    return files ? 'Given to each command as a temporary file' : (credential.delivers || []).join(', ');
  };
  /** What a command would get, before the server has seen this draft. */
  const givesPreview = draft => {
    const type = typeOf(draft.type);
    if (!type) return [];
    if (type.dynamic) return draft.vars.filter(row => row.name).map(row => ({ name: row.name }));
    if (draft.type === 'database') return [{ name: 'DATABASE_URL' }, ...(draft.fields.engine === 'postgres' ? [{ name: 'PGPASSWORD' }] : draft.fields.engine === 'mysql' ? [{ name: 'MYSQL_PWD' }] : [])];
    return [...type.fields, ...type.secrets].filter(entry => entry.env && applies(entry, draft.fields)).map(entry => ({ name: envFor(draft, entry), file: Boolean(entry.file) }));
  };
  const canTest = credential => credential.type === 'ssh' || Boolean(credential.fields?.baseUrl);
  const usageCount = (credential, partial = false) => { const n = credential.usedIn?.length || 0, unit = credential.usedIn?.some(item => item.kind === 'instructions') ? 'source' : 'skill'; return partial ? n ? 'At least ' + M.plural(n, unit) : 'Unknown' : M.plural(n, unit); };
  const day = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'unknown'; };
  const keyType = type => type === 'ssh-ed25519' ? 'ED25519' : type === 'ssh-rsa' ? 'RSA' : type?.startsWith('ecdsa') ? 'ECDSA' : 'Host key';
  const keyCommand = type => 'ssh-keygen -lf /etc/ssh/ssh_host_' + (type === 'ssh-rsa' ? 'rsa' : type?.startsWith('ecdsa') ? 'ecdsa' : 'ed25519') + '_key.pub';
  const installLine = publicKey => "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '" + publicKey + "' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys";

  const commands = (credential, { aliases = true } = {}) => {
    const id = credential.id || 'name', fields = credential.fields || {};
    if (credential.type === 'ssh') {
      if (aliases && fields.auth === 'key') return ['ssh ' + id + ' uptime', 'scp app.tar ' + id + ':/srv/'];
      return ['t3-vault ssh ' + id + ' -- uptime', ...(aliases ? ['t3-vault run ' + id + ' -- scp app.tar ' + id + ':/srv/'] : [])];
    }
    const lines = ['t3-vault run ' + id + ' -- <command>'];
    if (fields.baseUrl) lines.push('t3-vault http ' + id + ' GET ' + C.quote(fields.testPath || '<path>'));
    return lines;
  };
  const snippet = (credential, { aliases = true } = {}) => {
    const id = credential.id, fields = credential.fields || {};
    if (credential.type === 'ssh') return `Run commands on ${id} with its saved login:\n\n${aliases && fields.auth === 'key' ? `ssh ${id} '<command>'` : `t3-vault ssh ${id} -- '<command>'`}\n\nDon’t read or print credential files.`;
    if (fields.baseUrl) return `Call ${host(fields.baseUrl)}’s API with its saved key:\n\nt3-vault http ${id} GET <path>\nt3-vault http ${id} POST <path> --stdin < body.json\n\nPaths are relative to ${fields.baseUrl}. Don’t read or print credential files.`;
    return `Use ${id} for commands that need it:\n\nt3-vault run ${id} -- <command>\n\nThe command gets ${(credential.delivers || []).join(', ') || 'the saved values'}. Don’t read or print credential files.`;
  };
  const request = (draft, short = false) => {
    const fields = draft.fields || {};
    try {
      const base = new URL(fields.baseUrl); if (!base.pathname.endsWith('/')) base.pathname += '/';
      const url = new URL(fields.testPath || '.', base);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return 'Enter a valid address and relative test path.';
      if (fields.authType === 'query') url.searchParams.set(fields.authName || 'key', '••••••••');
      const address = (short ? url.pathname + url.search : url.href).replace(/%E2%80%A2/gi, '•');
      const header = fields.authType === 'query' ? '' : fields.authType === 'header' ? (fields.authName || 'X-API-Key') + ': ' + (fields.authPrefix ? fields.authPrefix + ' ' : '') + '••••••••\n' : 'Authorization: Bearer ••••••••\n';
      return 'GET ' + address + '\n' + (short ? 'Host: ' + base.host + '\n' : '') + header + 'accept: application/json';
    } catch { return 'Enter an address to preview the request.'; }
  };

  const validateField = (entry, value, fields) => {
    const blank = value === undefined || value === null || value === '';
    if (blank) return entry.optional || entry.kind === 'derived' ? null : entry.message || 'Enter ' + entry.label.toLowerCase() + '.';
    if (entry.kind === 'number') return Number.isInteger(Number(value)) && Number(value) >= entry.min && Number(value) <= entry.max ? null : entry.message;
    if (entry.kind === 'select') return entry.options.some(([option]) => option === value) ? null : 'Choose ' + entry.label.toLowerCase() + '.';
    if (entry.kind === 'host') return validHost(value) ? null : entry.message;
    if (!text(String(value), entry.max ?? 2048)) return entry.message || 'Use up to ' + (entry.max ?? 2048) + ' characters, on one line.';
    if (entry.pattern && !new RegExp(entry.pattern).test(value)) return entry.message;
    if (entry.key === 'baseUrl') {
      let base; try { base = new URL(value); } catch {}
      if (!base || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return 'Use an HTTP or HTTPS address without credentials, a query or a fragment.';
    }
    if (entry.key === 'authName' && fields.authType === 'header' && (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(value) || ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'expect', 'trailer', 'te', 'accept', 'content-type'].includes(value.toLowerCase()))) return 'Use a valid authentication header, such as X-API-Key.';
    if (entry.key === 'authPrefix' && (value.length > 128 || /[^\x20-\x7e]/.test(value))) return 'Use up to 128 printable characters for the prefix.';
    if (entry.key === 'testPath') {
      if (value.startsWith('/') || value.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return 'Use a relative path, such as account.';
      try {
        const base = new URL(fields.baseUrl); if (!base.pathname.endsWith('/')) base.pathname += '/';
        const url = new URL(value, base);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.hash) return 'The test path must stay under the address.';
      } catch { /* The address reports its own error. */ }
    }
    return null;
  };
  /** Field errors, keyed like the inputs: id, fields.host, secrets.token, env.token, vars. */
  const validate = (draft, { editing = false, names = [], secrets = {}, savedSecrets = [], needSecret = true } = {}) => {
    const errors = {}, type = typeOf(draft.type);
    if (!validName(draft.id)) errors.id = draft.id === 'new' ? 'That name is reserved. Choose another.' : 'Use up to 64 lowercase letters, numbers and single hyphens.';
    else if (!editing && names.includes(draft.id)) errors.id = draft.id + ' is taken.';
    if (!type) { errors.type = 'Choose a type.'; return errors; }
    if (typeof draft.description === 'string' && draft.description.length > 200) errors.description = 'Use up to 200 characters.';
    if (type.dynamic) {
      const rows = draft.vars.filter(row => row.name || row.value), seen = new Set();
      if (!rows.length) errors.vars = 'Add at least one variable.';
      for (const row of rows) {
        if (!validEnvName(row.name)) errors.vars = (row.name || 'Each variable') + ' needs a name of letters, numbers and underscores.';
        else if (seen.has(row.name)) errors.vars = row.name + ' is listed twice.';
        else if (row.secret && !row.value && !row.saved) errors.vars = 'Enter a value for ' + row.name + '.';
        seen.add(row.name);
      }
      return errors;
    }
    for (const entry of type.fields) {
      if (!applies(entry, draft.fields)) continue;
      const problem = validateField(entry, draft.fields[entry.key], draft.fields);
      if (problem) errors['fields.' + entry.key] = problem;
    }
    if (needSecret) for (const entry of type.secrets) {
      if (!applies(entry, draft.fields) || entry.optional) continue;
      const value = secrets[entry.key];
      if (!value && !savedSecrets.includes(entry.key)) errors['secrets.' + entry.key] = 'Enter ' + entry.label.toLowerCase() + '.';
      else if (value && !entry.multiline && !text(value.replace(/\r?\n$/, ''), 8192)) errors['secrets.' + entry.key] = 'Use up to 8192 characters, without line breaks.';
      else if (value && entry.multiline && value.length > 48 * 1024) errors['secrets.' + entry.key] = 'Use up to 48 KiB.';
    }
    for (const entry of [...type.fields, ...type.secrets]) {
      const value = draft.env?.[entry.key];
      if (entry.editableEnv && value && !validEnvName(value)) errors['env.' + entry.key] = 'Use letters, numbers and underscores, and not a name the system relies on.';
    }
    return errors;
  };
  const changes = (previous, current) => {
    const keys = new Set([...Object.keys(previous?.fields || {}), ...Object.keys(current?.fields || {})]);
    return [...keys].filter(key => key !== 'publicKey' && String(previous?.fields?.[key] ?? '') !== String(current?.fields?.[key] ?? ''));
  };
  const fieldLabel = (key, type) => (typeOf(type)?.fields || []).find(entry => entry.key === key)?.label || key;
  const matches = (credential, query) => !query.trim() || [credential.id, credential.description, target(credential), kind(credential), typeLabel(credential.type), credential.type, ...(credential.delivers || []), ...Object.values(credential.fields || {}).map(String)].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase());
  const needsAttention = (credential, attention) => credential.type === 'ssh' && (credential.fields?.auth === 'password' && !credential.hostKey || credential.test?.code === 'host-key-changed') || credential.test?.ok === false && (credential.test.code !== 'timeout' || attention?.some(row => row.id === credential.id));
  const threadUrl = (origin, environmentId) => origin?.threadId && environmentId ? '/' + encodeURIComponent(environmentId) + '/' + encodeURIComponent(origin.threadId) : null;
  const usesPlainSsh = (credential, aliases) => aliases && credential.type === 'ssh' && credential.fields?.auth === 'key';
  const originText = credential => credential.origin?.by === 'agent' ? 'Added by an agent' : credential.origin?.by === 'terminal' ? 'Added from a terminal' : null;

  return { usesPlainSsh, givesPreview, setTypes, typeOf, typeList, iconFor, badge, typeLabel, validName, applies, withDefaults, primarySecret, envFor, resolveEnvName, defaults, draftOf, payload, kind, secretKind, target, delivery, canTest, usageCount, day, keyType, keyCommand, installLine, commands, snippet, request, validate, changes, fieldLabel, matches, needsAttention, threadUrl, originText, state: M.credentialState };
})();

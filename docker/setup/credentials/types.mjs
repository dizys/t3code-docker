// What each kind of credential holds and how a command receives it. Everything
// here is data: the store validates against it, the CLI builds its flags from
// it and the Setup page draws its form from it, so a new type needs no new code
// unless a command needs something more than environment variables.
//
//   fields   not secret, shown everywhere
//   secrets  write-only, never leave the store except for a command that uses them
//
// `env` names the variable a command gets, with {NAME} standing for the
// credential's name. `file` delivers the value as a temporary file instead, and
// the variable holds its path. `when` shows an entry only for some field values.
const API_FIELDS = Object.freeze([
  { key: 'baseUrl', label: 'API address', kind: 'url', optional: true, max: 2048, placeholder: 'https://api.example.com/v1/', hint: 'Lets agents call it with t3-vault http, and lets Setup test it.' },
  { key: 'authType', label: 'Authentication', kind: 'select', default: 'bearer', needs: 'baseUrl', options: [['bearer', 'Bearer token'], ['header', 'Header'], ['query', 'Query parameter']] },
  { key: 'authName', label: 'Header or parameter name', optional: true, max: 128, needs: 'baseUrl', when: { authType: ['header', 'query'] }, placeholder: 'X-API-Key' },
  { key: 'authPrefix', label: 'Value prefix', optional: true, max: 128, needs: 'baseUrl', when: { authType: ['header'] }, placeholder: 'Token' },
  { key: 'testPath', label: 'GET test path', optional: true, max: 2048, needs: 'baseUrl', placeholder: 'account', hint: 'A relative path that needs authentication.' },
]);

const HOST = { kind: 'host', max: 253, message: 'Enter a hostname or IP address, without a username or port.' };
const USER = { pattern: '^[a-zA-Z_][a-zA-Z0-9_.-]*\\$?$', max: 64, message: 'Enter a valid username.' };

export const TYPES = Object.freeze({
  ssh: {
    label: 'SSH server', badge: 'SSH', icon: 'terminal', order: 1,
    fields: [
      { key: 'host', label: 'Host', ...HOST, placeholder: '192.0.2.10' },
      { key: 'port', label: 'Port', kind: 'number', default: 22, min: 1, max: 65535, message: 'Use a port from 1 to 65535.' },
      { key: 'username', label: 'Username', ...USER, placeholder: 'deploy' },
      { key: 'auth', label: 'Sign-in', kind: 'select', default: 'key', options: [['key', 'Key'], ['password', 'Password']] },
      { key: 'publicKey', label: 'Public key', kind: 'derived', optional: true, max: 16384, when: { auth: ['key'] } },
    ],
    secrets: [
      { key: 'privateKey', label: 'Private key', multiline: true, primary: true, when: { auth: ['key'] }, flag: 'key-file', placeholder: 'Paste a private key' },
      { key: 'password', label: 'Password', primary: true, when: { auth: ['password'] }, flag: 'password-file' },
    ],
  },
  token: {
    label: 'API token', badge: 'Token', icon: 'globe', order: 2, secretFirst: true,
    fields: API_FIELDS,
    secrets: [{ key: 'token', label: 'Token', primary: true, env: '{NAME}_TOKEN', editableEnv: true }],
  },
  login: {
    label: 'Username and password', badge: 'Login', icon: 'user-round', order: 3,
    fields: [
      { key: 'username', label: 'Username', max: 256, env: '{NAME}_USERNAME', editableEnv: true },
      { key: 'url', label: 'Address', optional: true, max: 2048, placeholder: 'https://example.com', env: '{NAME}_URL' },
    ],
    secrets: [{ key: 'password', label: 'Password', primary: true, env: '{NAME}_PASSWORD', editableEnv: true }],
  },
  database: {
    label: 'Database', badge: 'Database', icon: 'database', order: 4,
    fields: [
      { key: 'engine', label: 'Engine', kind: 'select', default: 'postgres', options: [['postgres', 'PostgreSQL'], ['mysql', 'MySQL'], ['mongodb', 'MongoDB'], ['redis', 'Redis']] },
      { key: 'host', label: 'Host', ...HOST, placeholder: 'db.example.net' },
      { key: 'port', label: 'Port', kind: 'number', optional: true, min: 1, max: 65535, message: 'Use a port from 1 to 65535.' },
      { key: 'database', label: 'Database', optional: true, max: 256 },
      { key: 'username', label: 'Username', optional: true, max: 256 },
      { key: 'options', label: 'Connection options', optional: true, max: 1024, placeholder: 'sslmode=require' },
      // rediss:// and mongodb+srv:// mean TLS and DNS lookups, so a pasted URL keeps its own.
      { key: 'scheme', label: 'URL scheme', kind: 'derived', optional: true, max: 32, pattern: '^[a-z][a-z0-9+]*$', message: 'Use a URL scheme, such as rediss.' },
    ],
    secrets: [{ key: 'password', label: 'Password', primary: true, optional: true }],
  },
  aws: {
    label: 'AWS', badge: 'AWS', icon: 'cloud', order: 5,
    fields: [
      { key: 'accessKeyId', label: 'Access key ID', max: 128, pattern: '^[A-Z0-9]+$', message: 'Enter an access key ID, such as AKIA followed by letters and numbers.', env: 'AWS_ACCESS_KEY_ID' },
      { key: 'region', label: 'Region', optional: true, max: 64, placeholder: 'us-east-1', env: 'AWS_REGION' },
    ],
    secrets: [
      { key: 'secretAccessKey', label: 'Secret access key', primary: true, env: 'AWS_SECRET_ACCESS_KEY' },
      { key: 'sessionToken', label: 'Session token', optional: true, env: 'AWS_SESSION_TOKEN' },
    ],
  },
  gcp: {
    label: 'Google Cloud', badge: 'Google Cloud', icon: 'cloud', order: 6,
    fields: [
      { key: 'project', label: 'Project', optional: true, max: 128, env: 'GOOGLE_CLOUD_PROJECT' },
      { key: 'clientEmail', label: 'Service account', optional: true, max: 256 },
    ],
    secrets: [{ key: 'serviceAccount', label: 'Service account key', multiline: true, primary: true, file: 'service-account.json', env: 'GOOGLE_APPLICATION_CREDENTIALS', placeholder: 'Paste the JSON key file' }],
  },
  kubernetes: {
    label: 'Kubernetes', badge: 'Kubernetes', icon: 'box', order: 7,
    fields: [],
    secrets: [{ key: 'kubeconfig', label: 'Kubeconfig', multiline: true, primary: true, file: 'kubeconfig', env: 'KUBECONFIG', placeholder: 'Paste the kubeconfig file' }],
  },
  git: {
    label: 'Git host', badge: 'Git', icon: 'git-branch', order: 8, secretFirst: true,
    fields: [
      { key: 'host', label: 'Host', ...HOST, default: 'github.com', placeholder: 'github.com', hint: 'Commands run with this credential can use git over HTTPS to this host.' },
      { key: 'username', label: 'Username', optional: true, max: 256, placeholder: 'x-access-token' },
      ...API_FIELDS,
    ],
    secrets: [{ key: 'token', label: 'Token', primary: true, env: 'GIT_TOKEN', editableEnv: true }],
  },
  registry: {
    label: 'Package registry', badge: 'Registry', icon: 'package', order: 9, secretFirst: true,
    fields: [
      { key: 'username', label: 'Username', optional: true, max: 256, env: '{NAME}_USERNAME' },
      ...API_FIELDS,
    ],
    secrets: [{ key: 'token', label: 'Token or password', primary: true, env: '{NAME}_TOKEN', editableEnv: true }],
  },
  file: {
    label: 'File', badge: 'File', icon: 'file-text', order: 10, secretFirst: true,
    fields: [{ key: 'filename', label: 'File name', default: 'credential', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', max: 128, message: 'Use letters, numbers, dots, hyphens and underscores.', hint: 'The temporary file gets this name, for tools that care.' }],
    secrets: [{ key: 'content', label: 'Contents', multiline: true, primary: true, file: true, env: '{NAME}_FILE', editableEnv: true, placeholder: 'Paste the file' }],
  },
  custom: {
    label: 'Custom', badge: 'Custom', icon: 'list', order: 11, dynamic: true,
    fields: [],
    secrets: [],
  },
});

export const TYPE_IDS = Object.freeze(Object.keys(TYPES));
export const isType = value => typeof value === 'string' && Object.hasOwn(TYPES, value);

/** Whether a field or secret applies, given the credential's fields with their defaults. */
export function applies(entry, fields = {}) {
  if (entry.needs && !fields[entry.needs]) return false;
  if (!entry.when) return true;
  return Object.entries(entry.when).every(([key, values]) => values.includes(fields[key]));
}

/** Field defaults filled in, so `when` sees what the store will save. */
export function withDefaults(type, fields = {}) {
  const result = { ...fields };
  for (const entry of TYPES[type].fields) if (result[entry.key] === undefined && entry.default !== undefined) result[entry.key] = entry.default;
  return result;
}

export const envStem = id => id.toUpperCase().replace(/-/g, '_');
/** cloudflare-token with {NAME}_TOKEN is CLOUDFLARE_TOKEN, not CLOUDFLARE_TOKEN_TOKEN. */
export function resolveEnvName(template, id) {
  if (!template.includes('{NAME}')) return template;
  const stem = envStem(id), suffix = template.replace('{NAME}_', '');
  return stem === suffix || stem.endsWith('_' + suffix) ? stem : template.replace('{NAME}', stem);
}

/** The variable each entry reaches a command under, for this credential. */
export function envNames(credential) {
  const spec = TYPES[credential.type], names = {};
  for (const entry of [...spec.fields, ...spec.secrets]) {
    if (!entry.env) continue;
    names[entry.key] = credential.env?.[entry.key] || resolveEnvName(entry.env, credential.id);
  }
  return names;
}

export const primarySecret = (type, fields = {}) => TYPES[type].secrets.find(entry => entry.primary && applies(entry, fields)) || null;

/** The page and CLI's view of the types. No functions, so it survives JSON. */
export const publicTypes = () => TYPE_IDS.map(id => ({ id, ...TYPES[id] })).sort((a, b) => a.order - b.order);

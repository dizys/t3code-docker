// Works out what a pasted value is. Used by Setup's paste box and by
// `t3-vault add` without --type. It only reads the text it is given, never the
// network, and returns the secrets it found so the caller can place them.
import { rebuildPrivateKey } from './keys.mjs';

const API = (baseUrl, testPath, auth = {}) => ({ baseUrl, testPath, authType: 'bearer', ...auth });
const TOKENS = [
  { pattern: /^(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/, label: 'a GitHub token', type: 'git', id: 'github', fields: { host: 'github.com', username: 'x-access-token', ...API('https://api.github.com/', 'user') }, env: { token: 'GH_TOKEN' } },
  { pattern: /^glpat-[A-Za-z0-9_.-]{16,}$/, label: 'a GitLab token', type: 'git', id: 'gitlab', fields: { host: 'gitlab.com', username: 'oauth2', ...API('https://gitlab.com/api/v4/', 'user', { authType: 'header', authName: 'PRIVATE-TOKEN' }) }, env: { token: 'GITLAB_TOKEN' } },
  { pattern: /^sk-ant-[A-Za-z0-9_-]{16,}$/, label: 'an Anthropic API key', type: 'token', id: 'anthropic', fields: API('https://api.anthropic.com/v1/', 'models', { authType: 'header', authName: 'x-api-key' }), env: { token: 'ANTHROPIC_API_KEY' } },
  { pattern: /^sk-[A-Za-z0-9_-]{20,}$/, label: 'an OpenAI API key', type: 'token', id: 'openai', fields: API('https://api.openai.com/v1/', 'models'), env: { token: 'OPENAI_API_KEY' } },
  { pattern: /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}$/, label: 'a Stripe key', type: 'token', id: 'stripe', fields: API('https://api.stripe.com/v1/', 'balance'), env: { token: 'STRIPE_API_KEY' } },
  { pattern: /^xox[abeprs]-[A-Za-z0-9-]{16,}$/, label: 'a Slack token', type: 'token', id: 'slack', fields: API('https://slack.com/api/', 'auth.test'), env: { token: 'SLACK_TOKEN' } },
  { pattern: /^npm_[A-Za-z0-9]{20,}$/, label: 'an npm token', type: 'registry', id: 'npm', fields: API('https://registry.npmjs.org/', '-/whoami'), env: { token: 'NPM_TOKEN' } },
];

const ENGINES = { postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', mongodb: 'mongodb', 'mongodb+srv': 'mongodb', redis: 'redis', rediss: 'redis' };
const safeDecode = value => { try { return decodeURIComponent(value); } catch { return value; } };
const databaseUrl = text => {
  const match = /^([a-z][a-z0-9+]*):\/\//i.exec(text);
  if (!match || !ENGINES[match[1].toLowerCase()]) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!url.hostname) return null;
  const scheme = match[1].toLowerCase(), engine = ENGINES[scheme], database = safeDecode(url.pathname.replace(/^\//, ''));
  const fields = { engine, ...(scheme !== engine && !['postgresql', 'mariadb'].includes(scheme) ? { scheme } : {}), host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}), ...(database ? { database } : {}), ...(url.username ? { username: safeDecode(url.username) } : {}), ...(url.search.length > 1 ? { options: url.search.slice(1) } : {}) };
  return { label: 'a ' + { postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB', redis: 'Redis' }[engine] + ' connection URL', type: 'database', id: database ? database.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') + '-db' : engine, fields, secrets: url.password ? { password: safeDecode(url.password) } : {} };
};

const serviceAccount = text => {
  if (!text.startsWith('{')) return null;
  try {
    const data = JSON.parse(text);
    if (data?.type !== 'service_account' || typeof data.private_key !== 'string') return null;
    return { label: 'a Google Cloud service account key', type: 'gcp', id: String(data.project_id || 'google-cloud').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'google-cloud', fields: { ...(data.project_id ? { project: String(data.project_id) } : {}), ...(data.client_email ? { clientEmail: String(data.client_email) } : {}) }, secrets: { serviceAccount: text } };
  } catch { return null; }
};

const kubeconfig = text => /^\s*apiVersion:\s*v1\s*$/m.test(text) && /^\s*kind:\s*Config\s*$/m.test(text) && /^clusters:/m.test(text)
  ? { label: 'a Kubernetes config', type: 'kubernetes', id: 'kubernetes', fields: {}, secrets: { kubeconfig: text } }
  : null;

// Both an ~/.aws/credentials block and a plain pair of variables.
const awsPair = text => {
  const id = /(?:aws_access_key_id|AWS_ACCESS_KEY_ID)\s*[=:]\s*"?([A-Z0-9]{16,})"?/.exec(text)?.[1], key = /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*"?([A-Za-z0-9/+=]{16,})"?/.exec(text)?.[1];
  if (!id || !key) return null;
  const session = /(?:aws_session_token|AWS_SESSION_TOKEN)\s*[=:]\s*"?([A-Za-z0-9/+=]+)"?/.exec(text)?.[1], region = /(?:^|\s)(?:region|AWS_REGION|AWS_DEFAULT_REGION)\s*[=:]\s*"?([a-z0-9-]+)"?/.exec(text)?.[1];
  return { label: 'AWS credentials', type: 'aws', id: 'aws', fields: { accessKeyId: id, ...(region ? { region } : {}) }, secrets: { secretAccessKey: key, ...(session ? { sessionToken: session } : {}) } };
};

// One that can't be rebuilt is still a key, so it gets a useful error at save.
const privateKey = text => {
  const key = rebuildPrivateKey(text);
  if (!key && !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return null;
  return { label: 'an SSH private key', type: 'ssh', id: '', fields: { auth: 'key' }, secrets: { privateKey: key ?? text } };
};

// Two or more NAME=value lines. Every value is treated as secret until the
// person says otherwise, because a miss here would show it on the page.
const dotenv = text => {
  const rows = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (rows.length < 2 && !/^export\s/.test(rows[0] || '')) return null;
  const secrets = {}, fields = {};
  for (const row of rows) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(row);
    if (!match) return null;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    // FOO= is common in these files, and an empty value has nothing to hide.
    (value ? secrets : fields)[match[1]] = value;
  }
  return Object.keys(secrets).length + Object.keys(fields).length ? { label: 'an environment file', type: 'custom', id: '', fields, secrets } : null;
};

/** Returns { type, label, id, fields, secrets, env, confident } for pasted text. */
export function detect(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const known = privateKey(text) || serviceAccount(text) || kubeconfig(text) || databaseUrl(text) || awsPair(text) || dotenv(text);
  if (known) return { env: {}, ...known, confident: true };
  if (!/\s/.test(text)) {
    if (/^(?:AKIA|ASIA)[A-Z0-9]{12,}$/.test(text)) return { type: 'aws', label: 'an AWS access key ID', id: 'aws', fields: { accessKeyId: text }, secrets: {}, env: {}, confident: true };
    for (const { pattern, label, type, id, fields, env } of TOKENS) {
      if (pattern.test(text)) return { type, label, id, fields, env, secrets: { token: text }, confident: true };
    }
    return { type: 'token', label: 'a token', id: '', fields: {}, env: {}, secrets: { token: text }, confident: false };
  }
  return /\n/.test(text)
    ? { type: 'file', label: 'a file', id: '', fields: {}, env: {}, secrets: { content: text + '\n' }, confident: false }
    : { type: 'login', label: 'a password', id: '', fields: {}, env: {}, secrets: { password: text }, confident: false };
}

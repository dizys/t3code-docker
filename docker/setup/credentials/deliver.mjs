// How a saved credential reaches a command: environment variables and temporary
// files. Nothing here starts a process.
import { TYPES, applies, envNames, envStem } from './types.mjs';

const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mongodb: 27017, redis: 6379 };
const databaseUrl = ({ fields, secrets }) => {
  const encode = encodeURIComponent, user = fields.username ? encode(fields.username) : '', password = secrets.password ? ':' + encode(secrets.password) : '';
  const auth = user || password ? user + password + '@' : '', host = fields.host.includes(':') ? `[${fields.host}]` : fields.host;
  return `${fields.scheme || fields.engine}://${auth}${host}${fields.port ? ':' + fields.port : ''}/${fields.database ? encode(fields.database) : ''}${fields.options ? '?' + fields.options : ''}`;
};
const databaseEnv = credential => {
  const { fields, secrets } = credential, env = { DATABASE_URL: databaseUrl(credential) };
  if (fields.engine === 'postgres') Object.assign(env, { PGHOST: fields.host, PGPORT: String(fields.port ?? DEFAULT_PORTS.postgres), ...(fields.username ? { PGUSER: fields.username } : {}), ...(secrets.password ? { PGPASSWORD: secrets.password } : {}), ...(fields.database ? { PGDATABASE: fields.database } : {}) });
  if (fields.engine === 'mysql') Object.assign(env, { MYSQL_HOST: fields.host, MYSQL_TCP_PORT: String(fields.port ?? DEFAULT_PORTS.mysql), ...(secrets.password ? { MYSQL_PWD: secrets.password } : {}) });
  if (fields.engine === 'redis' && secrets.password) env.REDISCLI_AUTH = secrets.password;
  return env;
};

// Git reads this from the environment, so `git push` works without touching
// anyone's git config. The helper reads the token from a variable at run time,
// which keeps it out of the command line that `ps` shows.
const gitHelper = stem => `!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$T3_VAULT_GIT_USERNAME_${stem}" "$T3_VAULT_GIT_TOKEN_${stem}"; }; f`;
const gitEnv = ({ id, fields, secrets }, base) => {
  const start = Number.parseInt(base.GIT_CONFIG_COUNT, 10) || 0, section = `credential.https://${fields.host}`, stem = envStem(id);
  const pairs = [[section + '.helper', ''], [section + '.helper', gitHelper(stem)]];
  const env = { [`T3_VAULT_GIT_USERNAME_${stem}`]: fields.username || 'x-access-token', [`T3_VAULT_GIT_TOKEN_${stem}`]: secrets.token, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${start + index}`] = key; env[`GIT_CONFIG_VALUE_${start + index}`] = value; });
  return env;
};

/** Every secret value a credential holds, for masking its command's output. */
export const secretValues = credential => Object.values(credential.secrets ?? {}).filter(value => typeof value === 'string' && value);

export function delivery(credential, { rename, base = process.env, askpass } = {}) {
  const spec = TYPES[credential.type], env = {}, files = [];
  if (spec.dynamic) return { env: { ...credential.fields, ...credential.secrets }, files, masks: secretValues(credential) };
  const names = envNames(credential);
  for (const entry of spec.fields) {
    const value = credential.fields[entry.key];
    if (entry.env && value !== undefined && value !== '' && applies(entry, credential.fields)) env[names[entry.key]] = String(value);
  }
  for (const entry of spec.secrets) {
    const value = credential.secrets[entry.key];
    if (value === undefined || !entry.env) continue;
    const target = entry.primary && rename ? rename : names[entry.key];
    if (entry.file) files.push({ env: target, name: entry.file === true ? credential.fields.filename || 'credential' : entry.file, content: value });
    else env[target] = value;
  }
  if (credential.type === 'aws' && credential.fields.region) env.AWS_DEFAULT_REGION = credential.fields.region;
  if (credential.type === 'database') Object.assign(env, databaseEnv(credential));
  if (credential.type === 'git') Object.assign(env, gitEnv(credential, base));
  if (credential.type === 'ssh' && credential.fields.auth === 'password') {
    // The password reaches the command as a private file runWith writes, not
    // in the environment where /proc/<pid>/environ would show it. Only the
    // file's path travels in env, which deliveredNames already hides.
    Object.assign(env, { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: base.DISPLAY || 't3-vault' });
    files.push({ env: 'T3_CREDENTIAL_PASSWORD_FILE', name: 'ssh-password', content: credential.secrets.password });
  }
  return { env, files, masks: secretValues(credential) };
}

/** Variable names a command would get, for showing to people and agents. */
export function deliveredNames(credential) {
  const { env, files } = delivery({ ...credential, secrets: Object.fromEntries(Object.keys(credential.secrets ?? {}).map(key => [key, 'x'])) }, { base: {}, askpass: '' });
  const names = [...Object.keys(env), ...files.map(file => file.env)];
  return names.filter(name => !/^(?:GIT_CONFIG_|T3_VAULT_|T3_CREDENTIAL_|SSH_ASKPASS|DISPLAY|GIT_TERMINAL_PROMPT)/.test(name));
}

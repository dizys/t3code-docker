import { createCredentialStore, credentialFailure, CredentialError } from '../credentials.mjs';
import { sshRequest, apiRequest } from './run.mjs';

const USAGE = `Use saved credentials without putting their values in commands:
  t3-ssh CONNECTION [--] COMMAND [ARGUMENT...]
  t3-api CONNECTION METHOD RELATIVE_PATH [--stdin]

Manage connections in Setup → Server credentials.
For JSON request bodies, use --stdin and pipe the body into t3-api.
Examples:
  t3-ssh build-server -- uptime
  t3-api project-api GET projects/demo-project
  printf '%s' '{"name":"demo-project"}' | t3-api project-api POST projects --stdin
`;

async function main() {
  const [kind, ...args] = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const id = args.shift(), store = createCredentialStore();
  if (!['ssh', 'api'].includes(kind)) throw new CredentialError('Use t3-ssh or t3-api.');
  if (kind === 'ssh') {
    if (args[0] === '--') args.shift();
    if (!args.length) throw new CredentialError('Supply a remote command after the connection ID.');
    process.exitCode = await sshRequest(await store.forUse(id), args);
  } else {
    const [method, relative, option, ...extra] = args;
    if (!method || relative === undefined || extra.length || option !== undefined && option !== '--stdin') throw new CredentialError('Use t3-api CONNECTION METHOD RELATIVE_PATH [--stdin].');
    let body;
    if (option === '--stdin') {
      if (['GET', 'HEAD'].includes(method)) throw new CredentialError('GET and HEAD requests cannot have a body.');
      const chunks = []; let length = 0;
      for await (const chunk of process.stdin) {
        length += chunk.length;
        if (length > 1024 * 1024) throw new CredentialError('The JSON request body exceeds 1 MiB.');
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString('utf8');
      try { JSON.parse(body); } catch { throw new CredentialError('Supply a valid JSON request body on stdin.'); }
    }
    process.exitCode = await apiRequest(await store.forUse(id), method, relative, { body });
  }
}

main().catch(error => {
  process.stderr.write(credentialFailure(error).body.error + '\n');
  process.exitCode = 1;
});

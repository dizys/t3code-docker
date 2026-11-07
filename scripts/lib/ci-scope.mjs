import { execFileSync } from 'node:child_process';

// Only documentation and its screenshot generator can skip image checks. Keep
// an allowlist: new build inputs, tests and workflow files get the full matrix.
export function documentationOnly(paths) {
  return paths.length > 0 && paths.every(file =>
    ['README.md', 'CONTRIBUTING.md', 'LICENSE', 'scripts/readme-media.js'].includes(file)
    || file.startsWith('docs/') && file.split('/').every(part => part && part !== '.' && part !== '..'));
}

export function checkScope(eventName, event, { cwd = process.cwd(), git = execFileSync } = {}) {
  const full = reason => ({ full: true, reason });
  if (!['pull_request', 'push'].includes(eventName) || event.ref?.startsWith('refs/tags/')) {
    return full('Release, scheduled or manually requested verification');
  }
  const from = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  const to = eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after;
  if (![from, to].every(sha => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha))) {
    return full('No complete change range; run all checks');
  }
  let paths;
  try {
    // Do not use the files API, whose pagination/truncation can hide build inputs.
    // No rename detection means moving a guide into the image is a code change.
    const range = `${from}${eventName === 'pull_request' ? '...' : '..'}${to}`;
    paths = git('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], {
      cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean);
  } catch {
    return full('Change range unavailable; run all checks');
  }
  return documentationOnly(paths)
    ? { full: false, reason: `Documentation only (${paths.length} paths); lint and source tests still run` }
    : full('Image, test or CI inputs changed, or the change range is empty');
}

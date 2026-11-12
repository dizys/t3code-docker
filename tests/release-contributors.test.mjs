import assert from 'node:assert/strict';
import test from 'node:test';
import { contributorInventory, contributorAcknowledgements, withContributorAcknowledgements, checkContributorAcknowledgements } from '../scripts/lib/release-contributors.mjs';

const SHA = 'f'.repeat(40), REPOSITORY = 'dizys/t3code-docker';
const account = login => ({ login, type: login.endsWith('[bot]') ? 'Bot' : 'User' });
const commit = (sha, author = account('maintainer')) => ({ sha, author, commit: { author: { name: 'Public author' } } });
const pr = (number, author = 'original-author', extra = {}) => ({ number, user: account(author), merged_at: '2026-11-11T00:00:00Z', base: { repo: { full_name: REPOSITORY } }, ...extra });
const input = api => ({ tag: 'v0.28.1', sourceSha: SHA, api });
function fixture() {
  const calls = [];
  const api = async route => {
    calls.push(route);
    if (route.startsWith('releases?')) return [
      { tag_name: 'v0.27.3' }, { tag_name: 'v0.28.0' }, { tag_name: 'v0.29.0' },
      { tag_name: 'v0.28.1-rc.1', prerelease: true }, { tag_name: 'v0.28.1', draft: true },
    ];
    if (route.startsWith('compare/v0.28.0...')) return { status: 'ahead', total_commits: 2, commits: [commit('a'.repeat(40)), commit(SHA)] };
    if (route.startsWith('commits/')) return [pr(126), pr(127), pr(128, 'closed-author', { merged_at: null }),
      pr(999, 'foreign-author', { base: { repo: { full_name: 'someone/else' } } }), pr(130, 'robot[bot]')];
    throw new Error(`Unexpected request ${route}`);
  };
  return { api, calls };
}

test('stable credits retain original PR authors after maintainer rewrites and include returning contributors', async () => {
  const f = fixture(), inventory = await contributorInventory(input(f.api));
  assert.equal(inventory.previousTag, 'v0.28.0');
  assert.equal(inventory.commitCount, 2);
  assert.deepEqual(inventory.contributors, [
    { login: 'maintainer', name: 'maintainer', pullRequests: [] },
    { login: 'original-author', name: 'original-author', pullRequests: [126, 127] },
  ]);
  const body = contributorAcknowledgements(inventory);
  assert.match(body, /Thank you/);
  assert.match(body, /@original-author: \[#126\]\(https:\/\/github.com\/dizys\/t3code-docker\/pull\/126\), \[#127\]/);
  assert.doesNotMatch(body, /closed-author|foreign-author|robot\[bot\]/);
  checkContributorAcknowledgements(body, inventory);
});

test('repeated evidence runs preserve human release notes and replace only the generated credit section', async () => {
  const inventory = await contributorInventory(input(fixture().api));
  const notes = '# A release\n\nUseful changes.\n', once = withContributorAcknowledgements(notes, inventory);
  assert.equal(withContributorAcknowledgements(once, inventory), once);
  const later = once + '\n## Image measurements\n\nStill here.\n';
  const updated = withContributorAcknowledgements(later, { ...inventory, contributors: [...inventory.contributors, { login: 'new-author', name: 'new-author', pullRequests: [131] }] });
  assert.match(updated, /Useful changes/); assert.match(updated, /Image measurements/);
  assert.match(updated, /@new-author/);
  assert.equal(updated.split('## Contributors').length, 2);
});

test('publication refuses missing thanks, original author, PR links or duplicate credit sections', async () => {
  const inventory = await contributorInventory(input(fixture().api)), correct = contributorAcknowledgements(inventory);
  for (const body of ['', correct.replace('Thank you', 'Changes'), correct.replace('@original-author', '@someone-else'),
    correct.replace('/pull/126', '/pull/999'), correct + '\n' + correct]) assert.throws(() => checkContributorAcknowledgements(body, inventory));
});

test('comparison and PR association pagination cannot omit later contributors', async () => {
  const commits = Array.from({ length: 101 }, (_, i) => commit((i + 1).toString(16).padStart(40, '0')));
  const calls = [];
  const api = async route => {
    calls.push(route);
    if (route.startsWith('releases?')) return [{ tag_name: 'v0.28.0' }];
    if (route.startsWith('compare/')) return { status: 'ahead', total_commits: 101, commits: route.endsWith('page=1') ? commits.slice(0, 100) : commits.slice(100) };
    if (route.startsWith(`commits/${commits[100].sha}/pulls`)) return route.endsWith('page=1')
      ? Array.from({ length: 100 }, (_, i) => pr(i + 1)) : [pr(101, 'last-author')];
    return [];
  };
  const inventory = await contributorInventory(input(api));
  assert.equal(inventory.commitCount, 101);
  assert.deepEqual(inventory.contributors.find(p => p.login === 'last-author').pullRequests, [101]);
  assert.ok(calls.some(c => c.startsWith('compare/') && c.endsWith('page=2')));
  assert.ok(calls.some(c => c.startsWith('commits/') && c.endsWith('page=2')));
});

test('first stable releases credit public commit identities without inventing GitHub accounts', async () => {
  const api = async route => route.startsWith('releases?') ? [] : route.startsWith('commits?')
    ? [{ ...commit(SHA, null), commit: { author: { name: 'Nora <tester>' } } }] : [];
  const inventory = await contributorInventory(input(api));
  assert.equal(inventory.previousTag, null);
  assert.match(contributorAcknowledgements(inventory), /Nora \\<tester\\>/);
  assert.doesNotMatch(contributorAcknowledgements(inventory), /@Nora/);
});

test('unavailable or inconsistent history prevents incomplete contributor inventories', async () => {
  for (const response of [
    { status: 'diverged', total_commits: 1, commits: [commit(SHA)] },
    { status: 'ahead', total_commits: 1, commits: [] },
    { status: 'ahead', total_commits: 2, commits: [commit(SHA), commit(SHA)] },
  ]) await assert.rejects(contributorInventory(input(async route => route.startsWith('releases?') ? [{ tag_name: 'v0.28.0' }] : response)));
  await assert.rejects(contributorInventory({ ...input(fixture().api), tag: 'v0.28.1-rc.1' }), /stable release/);
});

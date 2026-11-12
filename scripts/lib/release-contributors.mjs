// Stable release credits come from original PR authors, even after maintainer
// rewrites, and from the public authors of commits in the release range.
import assert from 'node:assert/strict';
import { REPOSITORY, releaseVersion } from './dockerhub-release.mjs';

const START = '<!-- t3-release-contributors:start -->';
const END = '<!-- t3-release-contributors:end -->';
const stable = tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag);
const compare = (a, b) => {
  const left = a.slice(1).split('.').map(BigInt), right = b.slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
};
async function pages(api, route) {
  const rows = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = await api(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    assert.ok(Array.isArray(batch), 'Invalid GitHub pagination response');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error('Contributor inventory exceeded the pagination limit');
}

export async function contributorInventory({ tag, sourceSha, api }) {
  releaseVersion(tag);
  assert.ok(stable(tag), 'Contributor inventory requires a stable release');
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const releases = await pages(api, 'releases');
  const previous = releases.filter(r => !r.draft && !r.prerelease && stable(r.tag_name) && compare(r.tag_name, tag) < 0)
    .sort((a, b) => compare(b.tag_name, a.tag_name))[0];
  const commits = [];
  if (previous) {
    for (let page = 1, total = Infinity; commits.length < total; page++) {
      assert.ok(page <= 1000, 'Contributor comparison exceeded the pagination limit');
      const batch = await api(`compare/${encodeURIComponent(previous.tag_name)}...${sourceSha}?per_page=100&page=${page}`);
      assert.ok(['ahead', 'identical'].includes(batch.status), 'Previous stable release is not an ancestor');
      assert.ok(Number.isSafeInteger(batch.total_commits) && batch.total_commits >= 0);
      total = batch.total_commits;
      assert.ok(Array.isArray(batch.commits) && (batch.commits.length || total === 0), 'Incomplete contributor comparison');
      commits.push(...batch.commits);
      assert.ok(commits.length <= total, 'Contributor comparison returned too many commits');
    }
  } else commits.push(...await pages(api, `commits?sha=${sourceSha}`));
  assert.equal(new Set(commits.map(c => c.sha)).size, commits.length, 'Duplicate commits in contributor inventory');
  const people = new Map(), pulls = new Map();
  const person = (user, name) => {
    if (user?.type === 'Bot' || /\[bot\]$/i.test(user?.login || name || '')) return null;
    if (user?.login) assert.match(user.login, /^[a-z0-9-]+$/i);
    const key = user?.login?.toLowerCase() || `name:${name}`;
    assert.ok(user?.login || typeof name === 'string' && name.trim(), 'A contributor has no public identity');
    if (!people.has(key)) people.set(key, { login: user?.login || null, name: user?.login || name.trim(), pullRequests: [] });
    return people.get(key);
  };
  for (const commit of commits) {
    assert.match(commit.sha, /^[a-f0-9]{40}$/);
    person(commit.author, commit.commit?.author?.name);
    for (const pr of await pages(api, `commits/${commit.sha}/pulls`)) {
      if (!pr.merged_at || pr.base?.repo?.full_name !== REPOSITORY) continue;
      assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0);
      pulls.set(pr.number, { number: pr.number, author: pr.user?.login || null });
      const author = person(pr.user, pr.user?.login);
      if (author && !author.pullRequests.includes(pr.number)) author.pullRequests.push(pr.number);
    }
  }
  return { tag, sourceSha, previousTag: previous?.tag_name || null, commitCount: commits.length,
    pullRequests: [...pulls.values()].sort((a, b) => a.number - b.number),
    contributors: [...people.values()].map(p => ({ ...p, pullRequests: p.pullRequests.sort((a, b) => a - b) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en')) };
}

const escape = text => text.replace(/[\\`*_{}\[\]()<>#!|@]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export function contributorAcknowledgements(inventory) {
  const lines = inventory.contributors.map(person => {
    const name = person.login ? `@${person.login}` : escape(person.name);
    const links = person.pullRequests.map(number => `[#${number}](https://github.com/${REPOSITORY}/pull/${number})`);
    return `- ${name}${links.length ? ': ' + links.join(', ') : ''}.`;
  });
  return `${START}\n## Contributors\n\nThank you to everyone who contributed code, reviews, testing and bug reports.${lines.length ? '\n\n' + lines.join('\n') : ''}\n${END}`;
}

export function withContributorAcknowledgements(body, inventory) {
  assert.equal(typeof body, 'string');
  const rest = body.replace(/<!-- t3-release-contributors:start -->[\s\S]*?<!-- t3-release-contributors:end -->/g, '').trimEnd();
  return `${rest}${rest ? '\n\n' : ''}${contributorAcknowledgements(inventory)}\n`;
}

export function checkContributorAcknowledgements(body, inventory) {
  assert.equal(typeof body, 'string');
  assert.equal(body.split(START).length, 2, 'Stable release must retain one contributor acknowledgements section');
  assert.ok(body.includes(contributorAcknowledgements(inventory)), 'Stable release contributor acknowledgements are missing or incomplete');
}

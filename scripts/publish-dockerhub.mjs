#!/usr/bin/env node
// Usage: node scripts/publish-dockerhub.mjs v0.18.0 [--dry-run]
// Requires gh, regctl, and (unless --dry-run) a logged-in Docker Hub account.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REPOSITORY, releaseVersion, releasePlan, publishPlan, verifyIndex, SOURCE } from './lib/dockerhub-release.mjs';
const exec = promisify(execFile);
const run = async (command, args, timeout = 60_000) => (await exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
const api = async (route) => JSON.parse(await run('gh', ['api', `repos/${REPOSITORY}/${route}`]));
const [tag, flag, ...extra] = process.argv.slice(2);
releaseVersion(tag ?? '');
if (extra.length || (flag && flag !== '--dry-run')) throw new Error('Usage: publish-dockerhub.mjs v0.18.0 [--dry-run]');
const dryRun = flag === '--dry-run';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3-dockerhub-'));
try {
  const release = await api(`releases/tags/${encodeURIComponent(tag)}`);
  const commit = await api(`commits/${encodeURIComponent(tag)}`);
  const latest = async () => (await api('releases/latest')).tag_name;
  const names = ['registry-verification.json', ...['core', 'browser'].flatMap((v) => ['amd64', 'arm64'].map((a) => `build-${v}-${a}.json`))];
  // Only the fixed evidence files are downloaded; no code from the release
  // tag is checked out or executed in this credentialed workflow.
  await run('gh', ['release', 'download', tag, '-R', REPOSITORY, '--dir', temporary, ...names.flatMap((name) => ['--pattern', name])]);
  const documents = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(temporary, name), 'utf8'))));
  const plans = releasePlan({ tag, release, latest: await latest(), sourceSha: commit.sha, verification: documents[0], builds: documents.slice(1) });
  const read = (ref) => run('regctl', ['manifest', 'get', ref, '--format', 'raw-body']);
  for (const p of plans) verifyIndex(await read(`${SOURCE}@${p.digest}`), p);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun, tag, plans }, null, 2));
  } else {
    const response = await fetch(`https://hub.docker.com/v2/repositories/${REPOSITORY}/`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || (await response.json()).is_private !== false) throw new Error(`Create ${REPOSITORY} as a public Docker Hub repository before publishing`);
    const tags = await publishPlan(plans, { read, latest, tag, report: console.log,
      existing: async (ref) => {
        try { return await read(ref); }
        catch (error) { if (/not found|404|manifest unknown/i.test(error.stderr || '')) return null; throw error; }
      },
      copy: (src, dst) => run('regctl', ['image', 'copy', '--referrers', '--force-recursive', src, dst], 30 * 60_000) });
    const evidence = { tag, sourceSha: commit.sha, publishedAt: new Date().toISOString(), tags };
    const output = process.env.DOCKERHUB_EVIDENCE || 'dockerhub-verification.json';
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Docker Hub ${tag}\n\nVerified ${tags.length} tags at \`${REPOSITORY}\`, preserving both tested architectures and index digests.\n`);
  }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }

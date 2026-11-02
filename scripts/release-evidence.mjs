#!/usr/bin/env node
// Usage: node scripts/release-evidence.mjs v0.18.0 <commit> <run-id> <directory> [--dry-run]
// Runs as the last job of a tag build, and needs only GH_TOKEN. <directory> holds
// the build-*.json records from that run. --dry-run checks the run and the
// registry and writes registry-verification.json, but leaves the release alone.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_FILES, REPOSITORY, releaseVersion } from './lib/dockerhub-release.mjs';
import { attachEvidence, attachPlan, checkRun, findRelease, ghcrReader, sha256, verifyRelease } from './lib/release-evidence.mjs';

const exec = promisify(execFile);
const gh = async (args) => (await exec('gh', args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const api = async (route) => JSON.parse(await gh(['api', `repos/${REPOSITORY}/${route}`]));
const [tag, sourceSha, runId, directory, flag, ...extra] = process.argv.slice(2);
if (!directory || extra.length || (flag && flag !== '--dry-run')) throw new Error('Usage: release-evidence.mjs v0.18.0 <commit> <run-id> <directory> [--dry-run]');
releaseVersion(tag);
assert.match(sourceSha, /^[a-f0-9]{40}$/);
assert.match(runId, /^\d+$/);
const dryRun = flag === '--dry-run';
const dir = path.resolve(directory);

const run = await api(`actions/runs/${runId}`);
const { jobs } = await api(`actions/runs/${runId}/jobs?per_page=100`);
assert.equal((await api(`commits/${tag}`)).sha, sourceSha, 'The release tag moved');
checkRun({ run, jobs, tag, sourceSha, self: process.env.GITHUB_RUN_ID === runId ? process.env.GITHUB_JOB : null });

// `gh run download` nests records by artifact name; the workflow's download doesn't.
const walk = async (at) => (await Promise.all((await fs.readdir(at, { withFileTypes: true }))
  .map((entry) => (entry.isDirectory() ? walk(path.join(at, entry.name)) : [path.join(at, entry.name)])))).flat();
const records = (await walk(dir)).filter((file) => /^build-.*\.json$/.test(path.basename(file)));
const builds = await Promise.all(records.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8'))));

const verification = await verifyRelease({ tag, sourceSha, run, builds, read: await ghcrReader(), report: console.log });
const output = path.join(dir, 'registry-verification.json');
await fs.writeFile(`${output}.tmp`, JSON.stringify(verification, null, 2) + '\n');
await fs.rename(`${output}.tmp`, output);
console.log(`Wrote ${output}: ${verification.images.length} tested images and ${verification.tags.length} tags passed`);

const files = await Promise.all(EVIDENCE_FILES.map(async (name) => {
  const file = name === 'registry-verification.json' ? output : records.find((entry) => path.basename(entry) === name);
  assert.ok(file, `Missing evidence file ${name}`);
  return { name, path: file, digest: sha256(await fs.readFile(file)) };
}));

const summary = [];
if (dryRun) {
  summary.push(`Dry run. This would do: ${JSON.stringify(attachPlan(await findRelease(gh, tag)))}`);
} else {
  const plan = await attachEvidence({ tag, files, gh });
  if (plan.create) summary.push('Created a draft release with the evidence attached.');
  else if (plan.upload.length) summary.push(`Attached ${plan.upload.length} evidence files.`);
  else summary.push('The published release already has its evidence, so nothing changed.');
  summary.push(plan.mirror
    ? 'The release was already published, so this started the Docker Hub mirror.'
    : plan.upload.length ? `Add the notes, then publish it: \`gh release edit ${tag} --draft=false --latest\`` : '');
}
const text = summary.filter(Boolean).join(' ');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Release evidence for ${tag}\n\n${text}\n`);

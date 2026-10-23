#!/usr/bin/env node
// README -> repository metadata only; never copies images or changes tags.
// --dry-run renders and compares without credentials or writes to Docker Hub.
// --check fails when the public Overview is missing or stale, without writing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { overviewFromReadme, syncOverview } from './lib/dockerhub-overview.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => !['--dry-run', '--check'].includes(arg))) throw new Error('Usage: sync-dockerhub-overview.mjs [--dry-run | --check]');
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10_000 });
  const sourceSha = stdout.trim();
  const content = overviewFromReadme(await fs.readFile(new URL('../README.md', import.meta.url), 'utf8'), sourceSha);
  if (process.env.DOCKERHUB_OVERVIEW_OUTPUT) await fs.writeFile(process.env.DOCKERHUB_OVERVIEW_OUTPUT, content.full_description);
  const evidence = { sourceSha, checkedAt: new Date().toISOString(), ...await syncOverview(content, {
    dryRun: args.includes('--dry-run'), check: args.includes('--check'),
    username: process.env.DOCKERHUB_USERNAME || 'dizys', token: process.env.DOCKERHUB_TOKEN,
  }) };
  if (process.env.DOCKERHUB_OVERVIEW_EVIDENCE) await fs.writeFile(process.env.DOCKERHUB_OVERVIEW_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const status = evidence.dryRun ? (evidence.matches ? 'Already matches' : 'Update needed (dry run)') : (evidence.changed ? 'Updated and publicly verified' : 'Publicly verified; already matches');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Docker Hub Overview\n\n${status}: [dizys/t3code-docker](${evidence.url})\n\nSource: \`${sourceSha}\` · ${evidence.bytes} bytes · SHA256 \`${evidence.sha256}\`\n`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
import fs from 'node:fs';
import { checkScope } from './lib/ci-scope.mjs';

let scope;
try {
  scope = checkScope(process.env.GITHUB_EVENT_NAME, JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
} catch {
  scope = { full: true, reason: 'Event unavailable; run all checks' };
}
console.log(scope.reason);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `full=${scope.full}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${scope.reason}.\n`);

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const agent = fileURLToPath(new URL("../docker/bin/t3-agent", import.meta.url));
const lib = path.dirname(fileURLToPath(new URL("../docker/lib/step-down.sh", import.meta.url)));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-agent-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = path.join(root, "calls");
  const resolver = path.join(root, "resolve.mjs");
  const env = {
    PATH: "/usr/bin:/bin", HOME: root,
    T3_INFRA_NODE: process.execPath, T3_PROVIDER_CLI: resolver,
    T3_STEP_DOWN_LIB: lib,
  };
  const resolveTo = (target) => fs.writeFile(resolver,
    `import { appendFileSync } from "node:fs";\n` +
    `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
    `process.stdout.write(${JSON.stringify(target)});\n`);
  const invoke = async (name, args = []) => {
    const link = path.join(root, name);
    await fs.symlink(agent, link);
    try {
      const result = await run("bash", [link, ...args], { env, timeout: 10_000 });
      return { status: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { status: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  const resolved = async () =>
    (await fs.readFile(calls, "utf8").catch(() => ""))
      .trim().split("\n").filter(Boolean).map(JSON.parse);
  return { invoke, resolved, resolveTo, root };
}

test("argv[0] selects the harness: cursor-agent maps to cursor and execs it", async (t) => {
  const f = await fixture(t);
  const stub = path.join(f.root, "stub");
  await fs.writeFile(stub, "#!/bin/sh\necho \"stub-exe $*\"\n", { mode: 0o755 });
  await f.resolveTo(stub);
  const result = await f.invoke("cursor-agent", ["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "stub-exe --version\n");
  assert.deepEqual(await f.resolved(), [["resolve", "cursor"]]);
});

test("a known agent that is not installed explains itself with exit 127", async (t) => {
  const f = await fixture(t);
  await f.resolveTo("/nonexistent/managed-claude");
  const result = await f.invoke("claude", ["--version"]);
  assert.equal(result.status, 127);
  assert.match(result.stderr, /claude is not installed yet/);
  assert.match(result.stderr, /t3-harness install claude/);
});

test("an unknown argv[0] is a usage error with exit 2", async (t) => {
  const f = await fixture(t);
  await f.resolveTo("");
  const result = await f.invoke("bogus-agent");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /run this as claude, codex, opencode, grok, cursor-agent or muse/);
  assert.deepEqual(await f.resolved(), []);
});

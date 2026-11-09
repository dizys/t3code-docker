import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { measureStorage } from "../docker/harness/storage/system.mjs";

const exec = promisify(execFile);
async function root(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-du-overflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("a real maxBuffer overflow falls back to root totals with the remaining time budget", async (t) => {
  const target = await root(t);
  const calls = [];
  const measured = await measureStorage([target], { timeout: 5000, run: async (_bin, args, options) => {
    calls.push({ args, options });
    if (args.includes("-s")) return { stdout: `8192\t${target}\n` };
    try {
      return await exec(process.execPath, ["-e", 'process.stdout.write("x".repeat(65536)); setInterval(() => {}, 1000)'], { ...options, maxBuffer: 1024 });
    } catch (error) {
      assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      throw error;
    }
  } });
  assert.deepEqual(measured, { sizes: { [target]: 8192 }, partial: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].options.timeout < calls[0].options.timeout);
});

test("fallback retains permission-error totals but timeouts never replace a good scan", async (t) => {
  const target = await root(t);
  let calls = 0;
  const result = await measureStorage([target], { run: async () => {
    if (++calls === 1) throw Object.assign(new Error("overflow"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
    throw Object.assign(new Error("permission denied"), { code: 1, stdout: `4096\t${target}\n` });
  } });
  assert.deepEqual(result, { sizes: { [target]: 4096 }, partial: true });
  calls = 0;
  await assert.rejects(measureStorage([target], { run: async () => {
    calls++; throw Object.assign(new Error("timeout"), { killed: true, stdout: `4096\t${target}\n` });
  } }), /did not finish/);
  assert.equal(calls, 1, "a timeout must not begin another traversal");
});

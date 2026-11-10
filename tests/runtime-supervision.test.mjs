import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processIdentity, supervisedChild, supervisorRecord } from "../docker/runtime/supervision.mjs";

test("supervision binds a live child to its parent's start time, boot, protocol and restart support", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-supervision-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(async () => { child.kill(); await exited; await fs.rm(root, { recursive: true, force: true }); });
  await once(child, "spawn");
  assert.equal(processIdentity(child.pid).parentPid, process.pid);
  const record = supervisorRecord(), file = path.join(root, "supervisor.json");
  const save = (value) => fs.writeFile(file, JSON.stringify(value));
  await save(record);
  assert.equal(supervisedChild(root, child.pid), true);
  assert.equal(supervisedChild(root, process.pid), false, "an unrelated PID is not a child");
  for (const patch of [{ startTime: "old-start" }, { bootId: "previous-boot" }, { protocol: 2 }, { restartRequests: false }, { pid: -1 }]) {
    await save({ ...record, ...patch });
    assert.equal(supervisedChild(root, child.pid), false);
  }
  await save(record);
  await fs.rename(file, `${file}.real`);
  await fs.symlink(`${file}.real`, file);
  assert.equal(supervisedChild(root, child.pid), false, "metadata cannot be read through a symlink");
});

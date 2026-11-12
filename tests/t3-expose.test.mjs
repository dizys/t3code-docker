// Argument validation for t3-expose (docker/bin/t3-expose).
//
//   node --test tests/t3-expose.test.mjs
//
// The port travels inside a JSON body to the setup server, so anything but
// digits would break out of it (`1,"x":1`). Both verbs validate before
// dialling; these run the real script with a throwaway state dir and no
// server, so reaching validation (exit 2) also proves nothing was dialled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const EXPOSE = fileURLToPath(new URL("../docker/bin/t3-expose", import.meta.url));

const run = (t, ...args) => {
  const home = mkdtempSync(path.join(tmpdir(), "t3-expose-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  try {
    execFileSync("bash", [EXPOSE, ...args], {
      env: { PATH: "/usr/bin:/bin", T3_SETUP_KEY: "fixture-setup-key", T3CODE_HOME: home },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: "", stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
};

test("stop rejects a port that would break out of its JSON body", (t) => {
  for (const port of ['1,"x":1', '3000;id', '$(id)', '`id`', '3 0 0 0', ' 3000', '3000\n', '0x3000', '+3000']) {
    const result = run(t, "stop", port);
    assert.equal(result.status, 2, JSON.stringify(port));
    assert.match(result.stderr, /not a port number/, JSON.stringify(port));
  }
});

test("stop without a port explains itself, and expose validates the same way", (t) => {
  const missing = run(t, "stop");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: t3-expose stop <port>/);
  const exposed = run(t, '1,"x":1');
  assert.equal(exposed.status, 2);
  assert.match(exposed.stderr, /not a port number/);
});

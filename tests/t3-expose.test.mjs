// Argument validation and polling for t3-expose (docker/bin/t3-expose).
//
//   node --test tests/t3-expose.test.mjs
//
// The port travels inside a JSON body to the setup server, so anything but
// digits would break out of it (`1,"x":1`). Both verbs validate before
// dialling; these run the real script with a throwaway state dir and no
// server, so reaching validation (exit 2) also proves nothing was dialled.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const EXPOSE = fileURLToPath(new URL("../docker/bin/t3-expose", import.meta.url));
const exec = promisify(execFile);

const run = async (t, args, env = {}) => {
  const home = mkdtempSync(path.join(tmpdir(), "t3-expose-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  try {
    const { stdout, stderr } = await exec("bash", [EXPOSE, ...args], {
      env: { PATH: "/usr/bin:/bin", T3_SETUP_KEY: "fixture-setup-key", T3CODE_HOME: home, T3_STEP_DOWN_LIB: fileURLToPath(new URL("../docker/lib", import.meta.url)), ...env },
      encoding: "utf8", timeout: 15_000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
};

test("stop rejects a port that would break out of its JSON body", async (t) => {
  for (const port of ['1,"x":1', '3000;id', '$(id)', '`id`', '3 0 0 0', ' 3000', '3000\n', '0x3000', '+3000']) {
    const result = await run(t, ["stop", port]);
    assert.equal(result.status, 2, JSON.stringify(port));
    assert.match(result.stderr, /not a port number/, JSON.stringify(port));
  }
});

test("stop without a port explains itself, and expose validates the same way", async (t) => {
  const missing = await run(t, ["stop"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: t3-expose stop <port>/);
  const exposed = await run(t, ['1,"x":1']);
  assert.equal(exposed.status, 2);
  assert.match(exposed.stderr, /not a port number/);
});

test("polling retries a dropped connection and discards tunnel data from an HTTP error", async (t) => {
  let polls = 0;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/ports/expose") {
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === "GET" && req.url === "/ports") {
      polls += 1;
      if (polls === 1) {
        req.socket.destroy();
        return;
      }
      res.statusCode = polls === 2 ? 503 : 200;
      const url = polls === 2 ? "https://stale.example.test" : "https://live.example.test";
      res.end(JSON.stringify({ tunnels: [{ port: 3000, state: "open", url }] }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await run(t, ["3000"], { T3_SETUP_PORT: String(server.address().port) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(polls, 3);
  assert.match(result.stdout, /Port 3000 is live at: https:\/\/live\.example\.test/);
  assert.doesNotMatch(result.stdout, /stale\.example\.test/);
});

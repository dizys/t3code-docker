import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const TOKEN = "pin-check-test-token";

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-pin-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.mkdir(path.join(root, "bin"));
  await fs.copyFile(new URL("../scripts/bump-versions.sh", import.meta.url), path.join(root, "scripts/bump-versions.sh"));
  const dockerfile = "ARG T3_VERSION=0.1.0\nARG CHROME_DEVTOOLS_MCP_VERSION=1.0.0\nARG PLAYWRIGHT_MCP_VERSION=1.0.0\nARG GH_MIN_VERSION=2.81.0\nARG MISE_VERSION=2026.9.10\n";
  await fs.writeFile(path.join(root, "Dockerfile"), dockerfile);
  await fs.writeFile(path.join(root, "bin/curl"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith("https://"))
headers = sys.stdin.read() if "@-" in args else ""
with open(os.environ["PIN_REQUESTS"], "a") as log:
    log.write(json.dumps({"url": url, "args": args, "headers": headers}) + "\\n")
if os.environ.get("PIN_OFFLINE") and "pingdotgg/t3code" in url:
    print("curl: (22) The requested URL returned error: 503", file=sys.stderr)
    sys.exit(22)
if "pingdotgg/t3code" in url:
    print(json.dumps({"tag_name": os.environ.get("PIN_T3_TAG", "v0.1.0")}))
elif "jdx/mise" in url:
    print(json.dumps({"tag_name": "v2026.9.10"}))
else:
    print(json.dumps({"version": "1.0.0"}))
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, GITHUB_TOKEN: TOKEN, PIN_REQUESTS: path.join(root, "requests.jsonl"), ...extra };
  const run = () => execute("bash", [path.join(root, "scripts/bump-versions.sh"), "--check"], { env, timeout: 5000 });
  const requests = async () => (await fs.readFile(env.PIN_REQUESTS, "utf8")).trim().split("\n").map(JSON.parse);
  return { root, run, requests, dockerfile };
}

test("pin checks authenticate only GitHub metadata and keep tokens out of arguments and output", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.match(result.stdout, /every pin is current/);
  assert.equal((result.stdout + result.stderr).includes(TOKEN), false);
  const requests = await f.requests();
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.args.some((arg) => arg.includes(TOKEN)), false);
    assert.equal(request.headers.trim(), request.url.startsWith("https://api.github.com/") ? `Authorization: Bearer ${TOKEN}` : "");
  }
});

test("public pin checks also work without a GitHub token", async (t) => {
  const f = await fixture(t, { GITHUB_TOKEN: "" });
  assert.match((await f.run()).stdout, /every pin is current/);
  assert.equal((await f.requests()).every((request) => !request.headers.trim()), true);
});

test("failed release lookups fail closed and preserve useful diagnostics", async (t) => {
  const f = await fixture(t, { PIN_OFFLINE: "1" });
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /HTTP|503/);
    assert.match(error.stderr, /could not check published releases for github-t3/);
    assert.equal((error.stdout + error.stderr).includes(TOKEN), false);
    return true;
  });
  assert.equal(await fs.readFile(path.join(f.root, "Dockerfile"), "utf8"), f.dockerfile);
});

test("a newer or invalid upstream version still blocks the pin check without editing the image", async (t) => {
  for (const tag of ["v0.1.1", "v0.1.1-preview.1"]) {
    const f = await fixture(t, { PIN_T3_TAG: tag });
    await assert.rejects(f.run(), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout + error.stderr, tag === "v0.1.1" ? /pin\(s\) behind/ : /Expected a stable T3 release tag/);
      return true;
    });
    assert.equal(await fs.readFile(path.join(f.root, "Dockerfile"), "utf8"), f.dockerfile);
  }
});

test("browser MCP checks include both resolved versions and lockfile root dependencies", async t => {
  const f = await fixture(t), directory = path.join(f.root, 'docker/browser-mcp');
  await fs.mkdir(directory, { recursive: true });
  const dependencies = { 'chrome-devtools-mcp': '1.0.0', '@playwright/mcp': '1.0.0' };
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies }));
  const lock = { packages: { '': { dependencies: { ...dependencies } }, 'node_modules/chrome-devtools-mcp': { version: '1.0.0' }, 'node_modules/@playwright/mcp': { version: '1.0.0' } } };
  const write = () => fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
  await write(); assert.match((await f.run()).stdout, /every pin is current/);
  lock.packages[''].dependencies['@playwright/mcp'] = '0.9.0'; await write();
  await assert.rejects(f.run(), error => error.code === 1 && /browser-mcp lock/.test(error.stdout));
  lock.packages[''].dependencies['@playwright/mcp'] = '1.0.0';
  lock.packages['node_modules/chrome-devtools-mcp'].version = '0.9.0'; await write();
  await assert.rejects(f.run(), error => error.code === 1 && /browser-mcp lock/.test(error.stdout));
});

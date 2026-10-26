import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { archiveStem, archiveChecksum, packageRelease, releaseForVersion, unpackRelease, validateArchive, fetchRelease } from "../docker/runtime/releases.mjs";
import { installRelease } from "../docker/runtime/manager.mjs";
import { installImageRelease } from "../docker/runtime/install.mjs";
import { runtimePaths, readJson, writeJson } from "../docker/runtime/state.mjs";
import { PATCH_REVISION, distributionBlob } from "../docker/runtime/distribution-spec.mjs";

const execute = promisify(execFile);
const VERSION = "0.1.1-nightly.20261019.3348";
const digest = "a".repeat(64);
const entry = (version = VERSION, extra = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: version.includes("nightly"), ...extra });
const sums = (version = VERSION) => ["x64", "arm64"].map((arch) => `${digest}  ${archiveStem(version, arch)}.tar.gz`).join("\n");
const source = async (url) => new Response(url.endsWith("/SHA256SUMS") ? sums(/\/v([^/]+)\/SHA256SUMS$/.exec(url)[1]) : JSON.stringify(url.endsWith("/latest") ? entry("0.1.0") : [entry()]));

async function world(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-release-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, { manifest, banner = VERSION, compatible = true, link = false, native = false, revision = PATCH_REVISION } = {}) {
  const root = await world(t);
  const stem = archiveStem(VERSION);
  const contents = path.join(root, stem);
  await fs.mkdir(path.join(contents, "client"), { recursive: true });
  if (manifest || native) await writeJson(path.join(contents, "package.json"), { name: "t3-runtime", version: manifest || VERSION, ...(native ? { containerPatch: { revision, source: "a".repeat(40), upstreamIntegrity: "sha256-" + "b".repeat(64) } } : {}) });
  await fs.writeFile(path.join(contents, "client/index.html"), "<html><body>client</body></html>");
  await fs.writeFile(path.join(contents, "t3"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') console.log(${JSON.stringify(banner)});
else if (process.argv[2] === '__service-preflight') console.log(JSON.stringify({status: ${JSON.stringify(compatible ? "ready" : "blocked")}, version: ${JSON.stringify(VERSION)}, launcherProtocol: 3, reason: 'requires a newer supervisor'}));
else if (process.argv[2] === 'auth') {
  const dir = path.join(process.env.T3CODE_HOME, 'userdata');
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, 'statev2.sqlite'), 'probe only');
  console.log(JSON.stringify({permissions:['orchestration:read']}));
}
`);
  if (link) await fs.symlink("/etc/passwd", path.join(contents, "escape"));
  const file = path.join(root, "fixture.tar.gz");
  await execute("/usr/bin/tar", ["-czf", file, "-C", root, stem]);
  const bytes = await fs.readFile(file);
  const release = { version: VERSION, name: "t3-runtime", root: stem, url: `https://github.com/pingdotgg/t3code/releases/download/v${VERSION}/${stem}.tar.gz`, integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}` };
  if (native) { release.patchRevision = PATCH_REVISION; release.url = distributionBlob(release.integrity.replace("sha256-", "sha256:")); }
  const env = { ...process.env, T3CODE_HOME: path.join(root, "home") };
  const bridge = path.join(root, "bridge.js");
  await fs.writeFile(bridge, 'console.log("data-t3-setup-entry");');
  return { root, release, env, bridge, bytes, fetcher: async (url) => new Response(url.includes("/token?") ? JSON.stringify({ token: "fixture" }) : url.endsWith("/SHA256SUMS") ? `${release.integrity.slice(7)}  ${stem}.tar.gz\n` : bytes), paths: runtimePaths(env) };
}

const MiB = 1024 * 1024;
const space = (available) => ({ bavail: available, bsize: 1 });

test("a patched build stages separately from the same unpatched version and records its provenance", async (t) => {
  const f = await fixture(t, { native: true });
  const old = path.join(f.paths.versions, VERSION);
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, "t3"), "Keep the original runtime");
  await writeJson(path.join(old, ".installed.json"), { version: VERSION });
  const target = await installRelease(f.paths, f.release, f);
  assert.equal(target, path.join(old, "patches", PATCH_REVISION));
  assert.equal((await readJson(path.join(target, ".installed.json"))).patchRevision, PATCH_REVISION);
  assert.equal(await fs.readFile(path.join(old, "t3"), "utf8"), "Keep the original runtime");
  assert.equal(await readJson(f.paths.selection), null);
});

test("an archive with a valid checksum but a different native patch never executes or becomes selectable", async (t) => {
  const f = await fixture(t, { native: true, revision: "c".repeat(64) });
  let executed = false;
  await assert.rejects(installRelease(f.paths, f.release, { ...f, run: async (command, args, options) => {
    if (command !== "/usr/bin/tar") { executed = true; throw new Error("Native code must not run"); }
    return execute(command, args, options);
  } }), /patch metadata/);
  assert.equal(executed, false);
  assert.equal(await readJson(f.paths.selection), null);
  assert.deepEqual(await fs.readdir(f.paths.versions), []);
});

test("verified OCI archive sizes bound downloads even when the storage response has no length", async (t) => {
  const f = await fixture(t, { native: true });
  for (const size of [f.bytes.length - 1, f.bytes.length + 1]) {
    const stage = await fs.mkdtemp(path.join(f.root, "size-"));
    await assert.rejects(unpackRelease(stage, { ...f.release, size }, f), /declared size/);
  }
  const stage = await fs.mkdtemp(path.join(f.root, "size-header-"));
  await assert.rejects(unpackRelease(stage, { ...f.release, size: f.bytes.length }, { fetcher: async (url) => new Response(url.includes("/token?") ? JSON.stringify({ token: "fixture" }) : f.bytes, { headers: url.includes("/token?") ? {} : { "content-length": String(f.bytes.length + 1) } }) }), /verified archive size/);
  const target = await installRelease(f.paths, { ...f.release, size: f.bytes.length }, f);
  await fs.access(path.join(target, "t3"));
});

test("anonymous native pull credentials never follow a storage redirect", async () => {
  const url = distributionBlob("sha256:" + "a".repeat(64)), cdn = "https://pkg-containers.githubusercontent.com/signed-runtime?temporary=fixture";
  const calls = [];
  const response = await fetchRelease(url, { fetcher: async (target, options) => {
    calls.push({ target, options });
    if (target.includes("/token?")) return new Response(JSON.stringify({ token: "public-only" }));
    if (target === url) return new Response(null, { status: 307, headers: { location: cdn } });
    assert.equal(target, cdn);
    return new Response("archive");
  }, token: "must-not-use-user-token" });
  assert.equal(await response.text(), "archive");
  assert.equal(calls[1].options.headers.authorization, "Bearer public-only");
  assert.equal(calls[2].options.headers.authorization, undefined);
});

test("a full state volume refuses staging before requesting an archive and keeps live state", async (t) => {
  const f = await fixture(t);
  const selection = { schema: 1, channel: "stable", version: null };
  await writeJson(f.paths.selection, selection);
  await fs.mkdir(path.join(f.paths.home, "userdata"), { recursive: true });
  const live = path.join(f.paths.home, "userdata/state.sqlite");
  await fs.writeFile(live, "live database");
  let fetched = false;
  t.mock.method(fs, "statfs", async () => space(64 * MiB));
  await assert.rejects(installRelease(f.paths, f.release, { ...f, fetcher: async () => { fetched = true; } }), /free space.*Free up storage/);
  assert.equal(fetched, false);
  assert.deepEqual(await fs.readdir(f.paths.versions), []);
  assert.deepEqual(await readJson(f.paths.selection), selection);
  assert.equal(await fs.readFile(live, "utf8"), "live database");
});

test("a known archive size admits a small release without requiring the whole download limit", async (t) => {
  const f = await fixture(t);
  t.mock.method(fs, "statfs", async () => space(65 * MiB));
  const staged = await installRelease(f.paths, f.release, { ...f,
    fetcher: async () => new Response(f.bytes, { headers: { "content-length": String(f.bytes.length) } }),
  });
  assert.equal((await readJson(path.join(staged, ".installed.json"))).version, VERSION);
});

test("insufficient download space cancels the response without creating an archive", async (t) => {
  const f = await fixture(t);
  t.mock.method(fs, "statfs", async () => space(64 * MiB + f.bytes.length - 1));
  for (const header of [String(f.bytes.length), undefined, "invalid", "-1"]) {
    const stage = await fs.mkdtemp(path.join(f.root, "stage-"));
    let cancelled = false;
    const fetcher = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: header === undefined ? {} : { "content-length": header },
    });
    await assert.rejects(unpackRelease(stage, f.release, { fetcher }), /free space/);
    assert.equal(cancelled, true, `response cancelled for length ${header}`);
    assert.deepEqual(await fs.readdir(stage), []);
  }
});

test("unknown download lengths require space for the bounded download and reserved headroom", async (t) => {
  const f = await fixture(t);
  t.mock.method(fs, "statfs", async () => space(364 * MiB));
  const staged = await installRelease(f.paths, f.release, f);
  assert.equal((await readJson(path.join(staged, ".installed.json"))).version, VERSION);
});

test("disk pressure during a stream stops before writing into the server's reserved space", async (t) => {
  const f = await fixture(t);
  const stage = await fs.mkdtemp(path.join(f.root, "stage-"));
  let checks = 0, cancelled = false;
  t.mock.method(fs, "statfs", async () => space(++checks < 3 ? 512 * MiB : 68 * MiB - 1));
  const fetcher = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(Buffer.alloc(4 * MiB)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(unpackRelease(stage, f.release, { fetcher }), /free space/);
  assert.equal((await fs.stat(path.join(stage, "download.tgz"))).size, 4 * MiB);
  assert.equal(cancelled, true);
  assert.equal(await readJson(f.paths.selection), null);
});

test("disk space is checked again before extraction and failed staging is removed", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const commands = [];
  t.mock.method(fs, "statfs", async () => space(++checks < 3 ? 512 * MiB : 64 * MiB));
  await assert.rejects(installRelease(f.paths, f.release, { ...f, run: async (command, args, options) => {
    commands.push(args[0]);
    return execute(command, args, options);
  } }), /free space/);
  assert.deepEqual(commands, ["-tzf", "-tvzf"], "an admitted download never implies extraction is safe");
  assert.deepEqual(await fs.readdir(f.paths.versions), []);
});

test("oversized or misleading content lengths never publish or execute a runtime", async (t) => {
  const f = await fixture(t);
  for (const length of [301 * MiB, f.bytes.length - 1, f.bytes.length + 1]) {
    let executed = false;
    await assert.rejects(installRelease(f.paths, f.release, { ...f,
      fetcher: async () => new Response(f.bytes, { headers: { "content-length": String(length) } }),
      run: async () => { executed = true; },
    }), /supported size|declared size/);
    assert.equal(executed, false);
    assert.deepEqual(await fs.readdir(f.paths.versions), []);
  }
});

test("both architectures resolve public GitHub releases and their exact checksums", async () => {
  for (const arch of ["x64", "arm64"]) for (const channel of ["stable", "nightly"]) {
    const release = await packageRelease(channel, { fetcher: source, arch });
    assert.equal(release.version, channel === "stable" ? "0.1.0" : VERSION);
    assert.equal(release.integrity, `sha256-${digest}`);
    assert.ok(release.url.endsWith(`-linux-${arch}.tar.gz`));
    assert.match(release.url, /^https:\/\/github.com\/pingdotgg\/t3code\/releases\/download\//);
  }
  await assert.rejects(packageRelease("preview", { fetcher: source }), /Stable or Nightly/);
  await assert.rejects(packageRelease("stable", { fetcher: source, arch: "riscv64" }), /amd64 and arm64/);
  await assert.rejects(releaseForVersion("../version", { fetcher: source }), /exact Stable or Nightly/);
});

test("nightly discovery skips previews and drafts, follows pages and stops at its bound", async () => {
  const calls = [];
  const preview = entry("0.1.1-preview.20261019.3350");
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes("page=1")) return new Response(JSON.stringify(Array(20).fill(preview)));
    if (url.includes("page=2")) return new Response(JSON.stringify([null, { tag_name: 123 }, entry(VERSION, { draft: true }), preview, entry()]));
    return source(url);
  };
  assert.equal((await packageRelease("nightly", { fetcher })).version, VERSION);
  assert.equal(calls.length, 3);
  let pages = 0;
  await assert.rejects(packageRelease("nightly", { fetcher: async () => { pages += 1; return new Response(JSON.stringify(Array(20).fill(preview))); } }), /published nightly/);
  assert.equal(pages, 5);
  for (const release of [preview, entry(VERSION), entry("0.1.0", { draft: true }), entry("0.1.0", { prerelease: true }), entry("0.1.0", { tag_name: "0.1.0" })]) {
    await assert.rejects(packageRelease("stable", { fetcher: async () => new Response(JSON.stringify(release)) }), /published stable/);
  }
});

test("missing, malformed or duplicate architecture checksums cannot select a release", async () => {
  const name = `${archiveStem(VERSION)}.tar.gz`;
  assert.equal(archiveChecksum(`${digest.toUpperCase()} *${name}\r\n`, name), digest);
  for (const text of ["", `${digest}  wrong.tar.gz`, `sha1  ${name}`, `${sums()}\n${sums()}`]) {
    await assert.rejects(releaseForVersion(VERSION, { fetcher: async () => new Response(text) }), /exactly one SHA-256/);
  }
});

test("GitHub rate limits, malformed metadata and oversized checksums report a failure", async () => {
  await assert.rejects(packageRelease("nightly", { fetcher: async () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }) }), /rate limit/);
  await assert.rejects(packageRelease("nightly", { fetcher: async () => new Response("", { status: 429 }) }), /rate limit/);
  await assert.rejects(packageRelease("nightly", { fetcher: async () => new Response("", { status: 503 }) }), /HTTP 503/);
  await assert.rejects(packageRelease("nightly", { fetcher: async () => new Response("{}") }), /release list/);
  await assert.rejects(releaseForVersion(VERSION, { fetcher: async () => new Response("a".repeat(1024 * 1024 + 1)) }), /metadata exceeded/);
});

test("asset redirects accept GitHub storage and reject other hosts or protocols", async () => {
  for (const location of ["https://release-assets.githubusercontent.com/a?signature=test", "https://objects.githubusercontent.com/a"]) {
    let calls = 0;
    const release = await releaseForVersion(VERSION, { fetcher: async (url, options) => {
      assert.equal(options.redirect, "manual");
      assert.deepEqual(options.headers, {});
      calls += 1;
      return calls === 1 ? new Response(null, { status: 302, headers: { location } }) : new Response(sums());
    } });
    assert.equal(release.version, VERSION);
    assert.equal(calls, 2);
  }
  for (const location of ["https://evil.example/archive", "http://github.com/archive", "https://user:password@github.com/archive", "https://github.com:444/archive"]) {
    let calls = 0;
    await assert.rejects(releaseForVersion(VERSION, { fetcher: async () => { calls += 1; return new Response(null, { status: 302, headers: { location } }); } }), /unsupported download host/);
    assert.equal(calls, 1);
  }
  await assert.rejects(releaseForVersion(VERSION, { fetcher: async () => new Response(null, { status: 302, headers: { location: "https://github.com/loop" } }) }), /too many times/);
});

test("optional GitHub credentials are sent only to the release API", async () => {
  const release = await packageRelease("nightly", { token: "test-token", fetcher: async (url, options) => {
    assert.equal(options.headers.authorization, url.startsWith("https://api.github.com/") ? "Bearer test-token" : undefined);
    return source(url);
  } });
  assert.equal(release.version, VERSION);
  await assert.rejects(packageRelease("nightly", { token: "test-token", fetcher: async () => new Response(null, { status: 302, headers: { location: "https://github.com/redirect" } }) }), /unsupported download host/);
});

test("archive paths, links, special files and excessive expansion fail before extraction", () => {
  const root = archiveStem(VERSION);
  const row = (type = "-", size = 12) => `${type}rwxr-xr-x 0/0 ${size} 2026-10-19 00:00 ${root}/t3\n`;
  assert.equal(validateArchive(`${root}/\n${root}/t3\n`, row("d", 0) + row(), root), 12);
  for (const name of ["/tmp/escape", `${root}/../escape`, "elsewhere/t3", `${root}/dir\\escape`, `${root}/./t3`, `${root}//t3`, `${root}/t3\n${root}/t3`]) assert.throws(() => validateArchive(name, row(), root), /unsafe/);
  for (const type of ["l", "h", "b", "c", "p"]) assert.throws(() => validateArchive(`${root}/t3`, row(type), root), /unsupported/);
  assert.throws(() => validateArchive(`${root}/t3`, row("-", 1024 ** 3 + 1), root), /unpacked release/);
});

test("verified archives stage a runnable release, preserve Setup and record capabilities", async (t) => {
  const f = await fixture(t);
  const dir = await installRelease(f.paths, f.release, f);
  assert.equal((await execute(path.join(dir, "t3"), ["--version"])).stdout.trim(), VERSION);
  const metadata = await readJson(path.join(dir, ".installed.json"));
  assert.equal((await readJson(path.join(dir, "package.json"))).distribution, f.release.url);
  assert.equal(metadata.integrity, f.release.integrity);
  assert.equal(metadata.database, "statev2.sqlite");
  assert.deepEqual(metadata.scopes, ["orchestration:read"]);
  assert.equal((await fs.readFile(path.join(dir, "client/index.html"), "utf8")).split("data-t3-setup-bridge").length, 2);
  assert.deepEqual(await fs.readdir(f.paths.versions), [VERSION]);
  assert.equal(await readJson(f.paths.selection), null, "staging never selects or restarts T3");
});

test("checksum, manifest, link and protocol failures never publish a staged runtime", async (t) => {
  for (const options of [{ corrupt: true }, { manifest: "0.1.0" }, { banner: "0.1.0" }, { compatible: false }, { link: true }]) {
    const f = await fixture(t, options);
    const release = options.corrupt ? { ...f.release, integrity: `sha256-${digest}` } : f.release;
    await assert.rejects(installRelease(f.paths, release, f), /integrity check|does not match|different T3 Code version|newer supervisor|unsupported links/);
    assert.deepEqual(await fs.readdir(f.paths.versions), []);
    assert.equal(await readJson(f.paths.selection), null);
  }
});

test("existing npm-era cached runtimes are reused without a download or repatching", async (t) => {
  const f = await fixture(t);
  const dir = await installRelease(f.paths, f.release, f);
  const marker = path.join(dir, ".installed.json");
  await writeJson(marker, { ...(await readJson(marker)), package: "@t3code/t3-linux-x64", integrity: "sha512-old" });
  const shell = await fs.readFile(path.join(dir, "client/index.html"), "utf8");
  assert.equal(await installRelease(f.paths, f.release, { ...f, fetcher: async () => { throw new Error("must not download"); } }), dir);
  assert.equal(await fs.readFile(path.join(dir, "client/index.html"), "utf8"), shell);
  assert.equal((await readJson(marker)).integrity, "sha512-old");
});

test("archive downloads reject tampered origins before fetching or extracting", async (t) => {
  const f = await fixture(t);
  const stage = path.join(f.root, "stage");
  await fs.mkdir(stage);
  let calls = 0;
  await assert.rejects(unpackRelease(stage, { ...f.release, url: "https://evil.example/archive" }, { fetcher: async () => { calls += 1; } }), /Invalid release download/);
  assert.equal(calls, 0);
});

test("image installs share verification and expose the runtime and manifest to unprivileged users", async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, "image/t3");
  await installImageRelease(VERSION, process.arch, destination, f);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(destination, "package.json"))).mode & 0o777, 0o644);
  assert.equal((await fs.stat(path.join(destination, "t3"))).mode & 0o777, 0o755);
  assert.equal((await readJson(path.join(destination, "package.json"))).version, VERSION);
  assert.deepEqual(await fs.readdir(path.dirname(destination)), ["t3"], "image staging is removed");
});

test("failed image verification keeps an existing runtime and removes staging", async (t) => {
  const f = await fixture(t, { banner: "0.1.0" });
  const destination = path.join(f.root, "image/t3");
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "existing"), "keep");
  await assert.rejects(installImageRelease(VERSION, process.arch, destination, f), /different version/);
  assert.equal(await fs.readFile(path.join(destination, "existing"), "utf8"), "keep");
  assert.deepEqual(await fs.readdir(path.dirname(destination)), ["t3"]);
});

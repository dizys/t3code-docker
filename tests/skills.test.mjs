import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { createSkillsService, scanSkillFiles, skillMetadata, skillRoots, readSkillFile } from "../docker/setup/skills.mjs";
import { listCodexSkills } from "../docker/setup/skills/codex.mjs";

const markdown = (name, body = "Local instructions.") => `---\nname: '${name}'\ndescription: >\n  Useful for\n  ${name} work.\n---\n${body}\n`;
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skills-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const put = async (relative, content) => {
    const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file;
  };
  return { home, env: {}, put };
}

test("skill roots follow provider environment overrides and keep supported providers distinct", () => {
  const roots = (provider) => skillRoots(provider, { home: "/fixture", env: { CODEX_HOME: "/codex", CLAUDE_CONFIG_DIR: "/claude", XDG_CONFIG_HOME: "/config", GROK_HOME: "/grok" } }).map((r) => r.path);
  assert.equal(roots("codex")[0], "/codex/skills");
  assert.equal(roots("claude")[0], "/claude/skills");
  assert.equal(roots("opencode")[0], "/config/opencode/skills");
  assert.equal(roots("grok")[0], "/grok/skills");
  assert.equal(roots("muse")[0], "/config/muse/skills");
  assert.ok(roots("cursor").includes("/fixture/.agents/skills"));
  assert.ok(roots("grok").includes("/fixture/.cursor/skills"));
  assert.deepEqual(roots("antigravity"), ["/fixture/.gemini/config/skills", "/fixture/.gemini/antigravity-cli/skills"]);
  assert.throws(() => roots("../escape"), /Unknown/);
});

test("frontmatter uses YAML scalars, including quoted names and folded descriptions, without alias expansion", () => {
  assert.deepEqual(skillMetadata(markdown("quoted-name"), "fallback"), { name: "quoted-name", description: "Useful for quoted-name work.", invocation: null, metadataError: null });
  assert.equal(skillMetadata(markdown("crlf").replaceAll("\n", "\r\n"), "fallback").name, "crlf");
  assert.match(skillMetadata("# No frontmatter", "fallback").metadataError, /No YAML/);
  assert.ok(skillMetadata("---\nname: [invalid\n---\n", "fallback").metadataError);
  assert.equal(skillMetadata("---\nname: &self [*self]\ndescription: *self\n---\n", "fallback").name, "fallback");
  assert.ok(skillMetadata("---\nname: one\nname: two\n---\n", "fallback").metadataError);
  assert.equal(skillMetadata("---\nname: deploy\ndescription: Deploy\ndisable-model-invocation: true\n---\n", "fallback").invocation, "manual");
  assert.ok(skillMetadata("---\nname: '" + "x".repeat(17000) + "'\n---\n", "fallback").metadataError.includes("16 KiB"));
});

test("discovery includes shared, native, duplicate-name, nested, broken and oversized skills without bodies", async (t) => {
  const f = await fixture(t);
  await f.put(".config/opencode/skills/group/one/SKILL.md", markdown("same"));
  await f.put(".claude/skills/two/SKILL.md", markdown("same"));
  await f.put(".agents/skills/shared/SKILL.md", markdown("shared"));
  await f.put(".config/opencode/skills/flat.md", markdown("flat"));
  await f.put(".config/opencode/skills/large/SKILL.md", "x".repeat(65537));
  await fs.symlink("/missing/disposable-skill", path.join(f.home, ".config/opencode/skills/broken"));
  const scan = await scanSkillFiles("opencode", f);
  assert.equal(scan.skills.length, 6);
  assert.equal(scan.skills.filter((row) => row.name === "same").length, 2);
  assert.equal(new Set(scan.skills.map((row) => row.id)).size, 6);
  assert.ok(scan.skills.find((row) => row.name === "broken").error);
  assert.match(scan.skills.find((row) => row.name === "large").error, /64 KiB/);
  assert.equal(scan.skills.find((row) => row.name === "shared").source, "Shared .agents");
  assert.ok(scan.skills.every((row) => row.state === "unknown" && !("content" in row)));
});

test("known-root scans bound entry counts, depth, byte reads and link cycles", async (t) => {
  const f = await fixture(t);
  await f.put(".claude/skills/deep/one/two/SKILL.md", markdown("deep"));
  await f.put(".claude/skills/second/SKILL.md", markdown("second"));
  await fs.symlink("..", path.join(f.home, ".claude/skills/second/cycle"));
  const limited = await scanSkillFiles("claude", { ...f, limits: { entries: 1 } });
  assert.ok(limited.warnings.some((warning) => warning.includes("safety limit")));
  const depth = await scanSkillFiles("claude", { ...f, limits: { depth: 1 } });
  assert.ok(depth.warnings.some((warning) => warning.includes("depth limit")));
  const cycle = await scanSkillFiles("claude", f);
  assert.ok(cycle.warnings.some((warning) => warning.includes("cycle")));
  const bytes = await scanSkillFiles("claude", { ...f, limits: { bytes: 20 } });
  assert.ok(bytes.warnings.some((warning) => warning.includes("byte limit")));
  assert.equal(bytes.skills[0].bytes, null);
});

test("an unreadable discovery root is a partial scan, not an empty authoritative inventory", async (t) => {
  const f = await fixture(t);
  const io = { ...fs, realpath: async () => { throw Object.assign(new Error("Access denied"), { code: "EACCES" }); } };
  const service = createSkillsService({ ...f, io });
  const listed = await service.list("claude");
  assert.equal(listed.coverage, "files");
  assert.equal(listed.skills.length, 0);
  assert.equal(listed.warnings.length, 1);
});

test("native Codex merges disabled and system skills, excludes repo skills, and coalesces refreshes", async (t) => {
  const f = await fixture(t);
  const file = await f.put(".codex/skills/one/SKILL.md", markdown("one"));
  const system = await f.put(".codex/skills/.system/builtin/SKILL.md", markdown("builtin"));
  let calls = 0;
  const service = createSkillsService({ ...f, getHarness: async () => ({ runnable: true, executable: "/managed/codex" }),
    nativeCodex: async (options) => {
      calls++; assert.equal(options.executable, "/managed/codex");
      return { skills: [{ path: file, scope: "user", name: "one", description: "Native metadata", enabled: false },
        { path: system, scope: "system", name: "builtin", description: "Built in", enabled: true },
        { path: "/project/.agents/skills/local/SKILL.md", scope: "repo", name: "local", description: "Project", enabled: true }], errors: [] };
    },
  });
  const lists = await Promise.all([service.list("codex"), service.list("codex", { refresh: true })]);
  assert.equal(calls, 1); assert.equal(lists[0], lists[1]);
  assert.equal(lists[0].coverage, "native");
  assert.equal(lists[0].skills.length, 2);
  const one = lists[0].skills.find((row) => row.name === "one");
  assert.equal(one.state, "disabled"); assert.equal(one.description, "Native metadata");
  assert.equal((await service.read("codex", one.id)).content, markdown("one"));
  assert.equal(calls, 1);
  await service.list("codex", { refresh: true }); assert.equal(calls, 2);
});

test("failed native discovery keeps known files with unverified availability", async (t) => {
  const f = await fixture(t);
  await f.put(".codex/skills/one/SKILL.md", markdown("one"));
  const service = createSkillsService({ ...f, getHarness: async () => ({ runnable: true, executable: "/managed/codex" }), nativeCodex: async () => { throw new Error("Native discovery unavailable"); } });
  const result = await service.list("codex");
  assert.equal(result.coverage, "files"); assert.equal(result.nativeError, "Native discovery unavailable");
  assert.equal(result.skills[0].native, false); assert.equal(result.skills[0].state, "unknown");
});

test("details only read discovered IDs and refuse retargeted or deleted links", async (t) => {
  const f = await fixture(t);
  const first = await f.put("outside/first.md", markdown("linked"));
  const second = await f.put("outside/second.md", "unrelated");
  await fs.mkdir(path.join(f.home, ".claude/skills/link"), { recursive: true });
  const link = path.join(f.home, ".claude/skills/link/SKILL.md"); await fs.symlink(first, link);
  const service = createSkillsService(f);
  const listed = await service.list("claude"), row = listed.skills[0];
  assert.equal((await service.read("claude", row.id)).content, markdown("linked"));
  await assert.rejects(service.read("claude", second), { code: "invalid" });
  await assert.rejects(service.read("claude", "0".repeat(32)), { code: "missing" });
  await assert.rejects(service.list("toString"), { code: "invalid" });
  await fs.unlink(link); await fs.symlink(second, link);
  await assert.rejects(service.read("claude", row.id), { code: "conflict" });
  await fs.unlink(link);
  await assert.rejects(service.read("claude", row.id), { code: "missing" });
  assert.equal(await fs.readFile(second, "utf8"), "unrelated");
});

test("read limits reject oversized files before open and bound files growing after stat", async (t) => {
  const f = await fixture(t);
  const large = await f.put("large.md", "x".repeat(65537));
  await assert.rejects(readSkillFile(large, 65536, { ...fs, open: () => assert.fail("oversized file opened") }), { code: "too_large" });
  const small = await f.put("small.md", "small"); let readBytes = 0, closed = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { stat: () => handle.stat(), close: async () => { closed = true; await handle.close(); }, read: async (buffer, offset, length, position) => {
      if (position === 0) await fs.appendFile(small, "x".repeat(100000));
      const result = await handle.read(buffer, offset, Math.min(length, 2048), position); readBytes += result.bytesRead; return result;
    } };
  } };
  await assert.rejects(readSkillFile(small, 65536, io), { code: "too_large" });
  assert.equal(readBytes, 65537); assert.equal(closed, true);
  const exact = await f.put("exact.md", "é".repeat(32768));
  assert.equal((await readSkillFile(exact)).bytes, 65536);
});

test("Codex exchange performs only initialize and skills/list and bounds malformed or stalled providers", async (t) => {
  const f = await fixture(t);
  const executable = await f.put("fake-codex", `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize') process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
 else if(message.method==='initialized') {}
 else if(message.method==='skills/list') process.stdout.write(JSON.stringify({id:2,result:{data:[{cwd:message.params.cwds[0],skills:[],errors:[]}]}})+'\\n');
 else process.exit(10);
});
`);
  await fs.chmod(executable, 0o700);
  assert.deepEqual(await listCodexSkills({ executable, home: f.home }), { cwd: f.home, skills: [], errors: [] });
  const malformed = await f.put("malformed", "#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.once('data',()=>{process.stdout.write('null\\n');setTimeout(()=>process.exit(0),200);});\n"); await fs.chmod(malformed, 0o700);
  await assert.rejects(listCodexSkills({ executable: malformed, home: f.home }), /invalid discovery response/);
  const oversized = await f.put("oversized", "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(10000));\n"); await fs.chmod(oversized, 0o700);
  await assert.rejects(listCodexSkills({ executable: oversized, home: f.home, maxBytes: 100 }), /response limit/);
  const stalled = await f.put("stalled", "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n"); await fs.chmod(stalled, 0o700);
  await assert.rejects(listCodexSkills({ executable: stalled, home: f.home, timeoutMs: 100 }), /timed out/);
});

test("Codex metadata settles only after the provider has stopped writing its home", async (t) => {
  const f = await fixture(t);
  const executable = await f.put("slow-close-codex", `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync('closed', 'shutdown finished'); process.exit(0); }, 75));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize') process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
 else if(message.method==='skills/list') process.stdout.write(JSON.stringify({id:2,result:{data:[{cwd:process.cwd(),skills:[],errors:[]}]}})+'\\n');
});
`);
  await fs.chmod(executable, 0o700);
  await listCodexSkills({ executable, home: f.home });
  assert.equal(await fs.readFile(path.join(f.home, "closed"), "utf8"), "shutdown finished");
});

test("Codex shutdown escalates a provider that ignores SIGTERM and waits for it to exit", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const executable = await f.put("stubborn-codex", `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
fs.writeFileSync('provider.pid', String(process.pid));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize') process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
 else if(message.method==='skills/list') process.stdout.write(JSON.stringify({id:2,result:{data:[{cwd:process.cwd(),skills:[],errors:[]}]}})+'\\n');
});
`);
  await fs.chmod(executable, 0o700);
  await listCodexSkills({ executable, home: f.home });
  const pid = Number(await fs.readFile(path.join(f.home, "provider.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

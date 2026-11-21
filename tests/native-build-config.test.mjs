import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executableBuildPlan, publicBuildEnvironment, assertPublicBuildEnvironment, installBuiltClient, serviceLauncherProtocol } from "../scripts/build-t3-runtime.mjs";

test("native builds bind launcher IPC to the exact source contract and reject unreviewed protocols", () => {
  for (const protocol of [3, 4]) assert.equal(serviceLauncherProtocol(`export const SERVICE_LAUNCHER_PROTOCOL = ${protocol} as const;\n`), protocol);
  for (const source of ["", "export const SERVICE_LAUNCHER_PROTOCOL = 5 as const;", "export const SERVICE_LAUNCHER_PROTOCOL = 3 as const;\nexport const SERVICE_LAUNCHER_PROTOCOL = 4 as const;"]) {
    assert.throws(() => serviceLauncherProtocol(source), /protocol requires review/);
  }
});

test("native Linux ARM64 retains upstream's host SEA packaging and artifact name", () => {
  const plan = executableBuildPlan("arm64", { platform: "linux", hostArch: "arm64" });
  assert.deepEqual(plan.args, ["pnpm", "exec", "node", "apps/server/scripts/cli.ts", "build-exe"]);
  assert.equal(plan.output, "t3");
});

test("explicit Linux targets remain available without mistaking another host for native ARM64", () => {
  for (const [arch, platform, hostArch] of [["x64", "linux", "x64"], ["x64", "linux", "arm64"], ["arm64", "linux", "x64"], ["arm64", "darwin", "arm64"]]) {
    const plan = executableBuildPlan(arch, { platform, hostArch });
    assert.deepEqual(plan.args.slice(-2), ["--target", `linux-${arch}`]);
    assert.equal(plan.output, `t3-linux-${arch}`);
  }
  assert.throws(() => executableBuildPlan("riscv64"), /supported Linux/);
});

const defaults = {
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZXhhbXBsZS50ZXN0JA",
  T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "public-client-id",
  T3CODE_RELAY_URL: "https://relay.example.test",
};
const example = (values) => Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n");

test("native builds retain only the release's checked-in public Connect defaults", () => {
  assert.deepEqual(publicBuildEnvironment(example({ ...defaults, CLERK_SECRET_KEY: "must-not-copy", T3CODE_HOSTED_APP_URL: "https://operator.example.test", T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "must-not-copy" })), defaults);
});

test("a missing public release value fails before silently disabling Connect", () => {
  for (const key of Object.keys(defaults)) {
    const values = { ...defaults }; delete values[key];
    assert.throws(() => publicBuildEnvironment(example(values)), new RegExp(key));
  }
});

test("invalid relay origins and private authentication values cannot enter the native build", () => {
  for (const value of ["not-a-url", "http://relay.example.test", "https://user:password@relay.example.test", "https://relay.example.test/path", "https://relay.example.test?token=private", "https://relay.example.test#fragment"]) {
    assert.throws(() => publicBuildEnvironment(example({ ...defaults, T3CODE_RELAY_URL: value })), /public Connect defaults/);
  }
  assert.throws(() => publicBuildEnvironment(example({ ...defaults, T3CODE_CLERK_PUBLISHABLE_KEY: "sk_live_private" })), /public Connect defaults/);
});

test('native packaging refuses an unpatched client before replacing anything, then installs the tested client only', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'native-client-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'source'), runtime = path.join(root, 'runtime');
  const build = path.join(checkout, 'apps/web/dist');
  await fs.mkdir(path.join(build, 'assets'), { recursive: true });
  await fs.mkdir(path.join(runtime, 'client'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'client/index.html'), 'original client');
  await fs.writeFile(path.join(runtime, 't3'), 'unchanged executable');
  await fs.writeFile(path.join(runtime, 'package.json'), '{"version":"exact"}');
  await fs.writeFile(path.join(build, 'index.html'), '<body><script type="module" src="/assets/native.js"></script></body>');
  await fs.writeFile(path.join(build, 'assets/native.js'), 'original code');
  await assert.rejects(installBuiltClient(checkout, runtime), /missing the Setup command provider/);
  assert.equal(await fs.readFile(path.join(runtime, 'client/index.html'), 'utf8'), 'original client');
  await fs.writeFile(path.join(build, 'assets/native.js'), 'window.__T3_SETUP_PALETTE_NATIVE__=1;');
  await installBuiltClient(checkout, runtime);
  assert.equal(await fs.readFile(path.join(runtime, 'client/assets/native.js'), 'utf8'), 'window.__T3_SETUP_PALETTE_NATIVE__=1;');
  assert.equal(await fs.readFile(path.join(runtime, 't3'), 'utf8'), 'unchanged executable');
  assert.equal(await fs.readFile(path.join(runtime, 'package.json'), 'utf8'), '{"version":"exact"}');
});

test('client compilation cannot load operator Vite environment files from a source checkout', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'native-public-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'apps/web'), { recursive: true });
  await fs.writeFile(path.join(root, '.env.example'), 'PUBLIC_DEFAULTS=checked-in');
  await fs.writeFile(path.join(root, 'apps/web/.env.example'), 'PUBLIC_EXAMPLE=checked-in');
  await assertPublicBuildEnvironment(root);
  for (const file of ['.env', '.env.local', '.env.production', 'apps/web/.env.production.local', 'apps/server/.env', 'apps/desktop/.env.development']) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'VITE_PRIVATE_VALUE=must-not-enter-the-client');
    await assert.rejects(assertPublicBuildEnvironment(root), /without local environment files/);
    await fs.rm(target);
  }
  await assertPublicBuildEnvironment(root);
});

test('integration smoke checks capability negotiation on the correct side of the runtime upgrade', async () => {
  const script = await fs.readFile(new URL('../scripts/t3-integration-smoke.mjs', import.meta.url), 'utf8');
  const upgrade = script.indexOf('const answer = await manager.update(');
  assert.ok(upgrade > 0);
  const upstream = script.slice(0, upgrade), patched = script.slice(upgrade);
  assert.match(upstream, /gatewayRead\.customModelCapabilityOverrides, false/);
  assert.match(upstream, /const customModels = \["smoke-model"\]/);
  assert.doesNotMatch(upstream, /customModelCapabilityOverrides, true/);
  assert.match(patched, /gatewayT3\.read\(\)\)\.customModelCapabilityOverrides, true/);
  assert.match(patched, /customModels: richCustomModels/);
  assert.match(patched, /config\.customModels, richCustomModels/);
});

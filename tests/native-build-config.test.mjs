import assert from "node:assert/strict";
import test from "node:test";
import { executableBuildPlan, publicBuildEnvironment } from "../scripts/build-t3-runtime.mjs";

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

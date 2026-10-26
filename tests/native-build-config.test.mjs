import assert from "node:assert/strict";
import test from "node:test";
import { publicBuildEnvironment } from "../scripts/build-t3-runtime.mjs";

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

#!/usr/bin/env node
// Inject the setup bridge into T3 Code's client shell.
//
// Runs at image build time, after installing T3's platform package. The shell
// is a static file upstream owns, so this reads like any other build step that
// would fail loudly rather than ship: if a future release moves the `</body>` or renames
// the client directory, the build stops here, and scripts/smoke-test.sh checks
// the served HTML again in the running container. Both exist so a T3 bump
// cannot silently drop the only routes from the app back to the console: the
// pill on the pairing screen and the Setup entry in Settings.
//
// The paths can be overridden for a local dry run:
//   T3_CLIENT_SHELL=/tmp/index.html T3_SETUP_BRIDGE=docker/t3-client/setup-bridge.js \
//     node docker/t3-client/patch.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const { injectSetupBridge } = await import(existsSync(new URL("../runtime/client-shell.mjs", import.meta.url)) ? new URL("../runtime/client-shell.mjs", import.meta.url) : "file:///opt/t3-runtime/client-shell.mjs");

// T3 lives in the root-owned immutable prefix, not the mutable npm prefix.
const T3_PREFIX = process.env.T3_INFRA_PREFIX || "/opt/t3";
const SHELL = process.env.T3_CLIENT_SHELL
  || `${T3_PREFIX}/client/index.html`;
const BRIDGE = process.env.T3_SETUP_BRIDGE
  || "/usr/local/share/t3-client/setup-bridge.js";
const html = readFileSync(SHELL, "utf8");

if (!html.includes("</body>")) {
  console.error(`[patch] ${SHELL}: no </body> to inject before - upstream layout changed`);
  process.exit(1);
}

const bridge = readFileSync(BRIDGE, "utf8");
if (!bridge.includes("data-t3-setup-entry")) {
  console.error(`[patch] ${BRIDGE}: does not look like the setup bridge`);
  process.exit(1);
}
if (bridge.includes("</script")) {
  console.error(`[patch] ${BRIDGE}: contains </script and cannot be inlined`);
  process.exit(1);
}

const next = injectSetupBridge(html, bridge);
if (next !== html) writeFileSync(SHELL, next);
console.log(`[patch] ${SHELL}: setup bridge ${next === html ? "already present and current" : "injected"}`);

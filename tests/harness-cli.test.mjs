import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../docker/bin/t3-harness", import.meta.url));
const catalogue = new URL("../docker/harness/catalogue.mjs", import.meta.url).href;

// Run the actual shell/Node CLI with injected modules. A package call throws,
// exposing agent IDs that accidentally fall through to the added-tool route.
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "t3-harness-cli-"));
  const manager = path.join(home, "manager.mjs");
  const provider = path.join(home, "provider.mjs");
  await writeFile(manager, `
    export { CATALOGUE, SOURCE_CONTROL } from ${JSON.stringify(catalogue)};
    export function createHarnessManager() {
      const fact = (id) => ({ id, installedVersion: "1.4.7-R6101.1" });
      const lifecycle = (kind) => async (id, options = {}) => ({
        ok: true, harness: fact(id), kind, options,
      });
      return {
        resolve: async (id) => fact(id),
        install: lifecycle("install"), update: lifecycle("update"),
        uninstall: lifecycle("uninstall"),
        packages: new Proxy({}, { get() { throw new Error("agent routed as an added tool"); } }),
      };
    }
  `);
  await writeFile(provider, "export function createProviderIntegration() { return { sync: async () => ({ ok: true }) }; }\n");
  return {
    home,
    async call(command, ...args) {
      const result = await run("bash", [cli, command, "muse", ...args, "--json"], {
        env: { ...process.env, HOME: home, T3_INFRA_NODE: process.execPath,
          T3_HARNESS_MODULE: manager, T3_PROVIDER_MODULE: provider,
          T3_STEP_DOWN_LIB: fileURLToPath(new URL("../docker/lib", import.meta.url)) },
        timeout: 10_000,
      });
      return JSON.parse(result.stdout);
    },
  };
}

for (const command of ["status", "install", "update", "uninstall"]) {
  test(`t3-harness ${command} muse uses the agent route`, async () => {
    const world = await fixture();
    try {
      const explicit = command === "install" || command === "update";
      const result = await world.call(command, ...(explicit ? ["--version", "1.4.7-R6101.1"] : []));
      assert.equal(result.harness.id, "muse");
      assert.equal(result.harness.installedVersion, "1.4.7-R6101.1");
      if (command !== "status") {
        assert.equal(result.ok, true);
        assert.equal(result.kind, command);
        assert.deepEqual(result.options, explicit ? { version: "1.4.7-R6101.1" } : {});
        assert.equal(result.sync.ok, true);
      }
    } finally {
      await rm(world.home, { recursive: true, force: true });
    }
  });
}

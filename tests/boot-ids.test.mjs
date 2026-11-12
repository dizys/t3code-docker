import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entrypoint = fileURLToPath(new URL("../docker/entrypoint.sh", import.meta.url));
// Stop at the first external command, before any account or volume changes.
const run = (ids) => spawnSync("bash", ["-c", `
  realpath() { printf 'validated:%s:%s' "$PUID" "$PGID" >&2; return 99; }
  id() { return 99; }
  export -f realpath id
  exec bash "$1"
`, "fixture", entrypoint], { encoding: "utf8", env: { PATH: process.env.PATH, T3_RUN_DIR: "/tmp/t3-boot-test/run", T3_STEP_DOWN_LIB: fileURLToPath(new URL("../docker/lib", import.meta.url)), ...ids } });

test("invalid owner ids fail before account tools or volume changes", () => {
  for (const name of ["PUID", "PGID"]) for (const value of ["-1", "abc", "1 2", "1\n2", "4294967295", "9".repeat(100)]) {
    const result = run({ [name]: value });
    assert.equal(result.status, 1, `${name}=${JSON.stringify(value)}`);
    assert.match(result.stderr, new RegExp(`ERROR: ${name} must be`));
    assert.doesNotMatch(result.stderr, /validated:/);
  }
});

test("default, zero, large and zero-padded owner ids reach boot as decimal integers", () => {
  for (const [ids, expected] of [[{}, "1000:1000"], [{ PUID: "", PGID: "" }, "1000:1000"], [{ PUID: "0", PGID: "000" }, "0:0"], [{ PUID: "0001001", PGID: "4294967294" }, "1001:4294967294"]]) {
    const result = run(ids);
    assert.equal(result.status, 99);
    assert.equal(result.stderr, `validated:${expected}`);
  }
});

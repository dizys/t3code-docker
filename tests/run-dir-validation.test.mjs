import assert from "node:assert/strict";
import test from "node:test";
import { defaultRunDir, resolveRunDir } from "../docker/runtime/state.mjs";

// Dot segments must not sneak past the / and /tmp refusal: /tmp/.,
// /tmp/../tmp, /. and /tmp/.. are /tmp or / once normalized.
const bypasses = ["/", "/tmp", "/tmp/", "//", "///", "//tmp", "/tmp//",
  "/.", "/./", "/..", "/../", "/tmp/.", "/tmp/./", "/tmp/..", "/tmp/../",
  "/tmp/../tmp", "/tmp/subdir/..", "/a/../../tmp"];
for (const bad of bypasses) {
  test(`run dir ${bad} is refused`, () => {
    assert.throws(() => resolveRunDir({ T3_RUN_DIR: bad }), /T3_RUN_DIR/);
  });
}

test("a relative run dir is refused", () => {
  assert.throws(() => resolveRunDir({ T3_RUN_DIR: "relative/path" }), /absolute/);
});

test("supported overrides still pass through untouched", () => {
  for (const ok of ["/tmp/t3code", "/tmp/subdir/../other", "/run/t3", "/home/t3/.t3/run/"]) {
    assert.equal(resolveRunDir({ T3_RUN_DIR: ok }), ok);
  }
});

test("the default run dir lives under T3CODE_HOME", () => {
  assert.equal(resolveRunDir({}), "/home/t3/.t3/run");
  assert.equal(resolveRunDir({ T3CODE_HOME: "/state/.t3" }), "/state/.t3/run");
  assert.equal(resolveRunDir({ HOME: "/home/u" }), "/home/u/.t3/run");
  assert.equal(defaultRunDir({ T3CODE_HOME: "/state/.t3" }), "/state/.t3/run");
});

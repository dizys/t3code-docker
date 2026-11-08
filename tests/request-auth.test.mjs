// Unit tests for reading auth off a request (docker/setup/request-auth.mjs).
//
//   node --test tests/request-auth.test.mjs
//
// A custom setup key may be any printable ASCII (validKey), so the cookie
// /login sets - encodeURIComponent(KEY) - must read back as the key itself
// for every one of them. Before, a key with `@ # %` logged in once and
// then bounced back to the unlock screen, and a value containing `=`
// never parsed at all.
import assert from "node:assert/strict";
import test from "node:test";

import { cookieValue, forwardedPrefix } from "../docker/setup/request-auth.mjs";
import { validKey } from "../docker/setup/setup-key.mjs";

const headerFor = (key) => `other=1; t3setup=${encodeURIComponent(key)}; theme=dark`;

test("every valid key round-trips through the cookie /login sets", () => {
  for (const key of ["p@ss#x", "a=b;c", "100%", "p@ss-word_!~", "eq=uals==", "%41bc", "a%2Fb", "plain-key-123"]) {
    assert.ok(validKey(key), key);
    assert.equal(cookieValue(headerFor(key), "t3setup"), key, key);
  }
});

test("the cookie is found by name, split on the first = only", () => {
  assert.equal(cookieValue("t3setup=a=b=c", "t3setup"), "a=b=c");
  assert.equal(cookieValue("t3setupx=nope; t3setup=yes", "t3setup"), "yes");
  assert.equal(cookieValue("theme=dark", "t3setup"), undefined);
  assert.equal(cookieValue(undefined, "t3setup"), undefined);
  assert.equal(cookieValue("", "t3setup"), undefined);
  assert.equal(cookieValue("t3setup", "t3setup"), undefined, "no value is no cookie");
  assert.equal(cookieValue("t3setup=", "t3setup"), "");
});

test("a hand-set cookie carrying the key itself still reads back", () => {
  // Not valid percent-encoding, so never what /login set - but the raw text
  // is the key, and the caller still compares it in full.
  assert.equal(cookieValue("t3setup=x%zz", "t3setup"), "x%zz");
  assert.equal(cookieValue("t3setup=raw-key", "t3setup"), "raw-key");
});

const prefix = (value) => forwardedPrefix({ "x-forwarded-prefix": value });

test("a plain forwarded prefix is kept, trailing slashes trimmed", () => {
  assert.equal(prefix("/__setup"), "/__setup");
  assert.equal(prefix("/__setup/"), "/__setup");
  assert.equal(prefix("/a/b-c.d~e"), "/a/b-c.d~e");
  assert.equal(prefix(" /__setup "), "/__setup");
});

test("dot segments are refused, as the router refuses them", () => {
  for (const bad of ["/../evil", "/a/../b", "/./x", "/a/./b", "/..", "/."]) {
    assert.equal(prefix(bad), "", bad);
  }
});

test("empty segments are refused: //host would make redirects absolute", () => {
  for (const bad of ["//evil.com", "/a//b", "///evil.com"]) {
    assert.equal(prefix(bad), "", bad);
  }
});

test("anything that is not a plain path is refused", () => {
  for (const bad of ["", "setup", "/%2e%2e/evil", "/..;evil", "/a\\b", "/a b", undefined, 42]) {
    assert.equal(prefix(bad), "", JSON.stringify(bad));
  }
  assert.equal(forwardedPrefix({}), "");
  assert.equal(forwardedPrefix(undefined), "");
});

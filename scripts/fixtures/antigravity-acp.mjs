import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const receipt = process.env.T3_SMOKE_BROWSER_RECEIPT;
const authenticated = `${receipt}.authenticated`;
const input = createInterface({ input: process.stdin });

if (process.argv.includes("--login")) {
  assert.equal(process.env.DISPLAY, undefined);
  assert.equal(process.env.BROWSER, undefined);
  const params = new URLSearchParams({ redirect_uri: "https://antigravity.google/oauth-callback",
    response_type: "code", state: "fixture-state", code_challenge: "fixture-challenge", code_challenge_method: "S256" });
  console.log("https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fwrong.example");
  console.log(`https://accounts.google.com/o/oauth2/auth?${params}`);
  for await (const code of input) {
    assert.equal(code, "fixture-authorization-code");
    writeFileSync(authenticated, "yes\n");
    break;
  }
} else {
  writeFileSync(receipt, [process.env.BROWSER, process.env.NODE_CHANNEL_FD ?? "unset",
    process.env.NODE_CHANNEL_SERIALIZATION_MODE ?? "unset"].join("\n"));
  for await (const line of input) {
    const { id, method } = JSON.parse(line);
    if (id === undefined) continue;
    const answer = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
    if (method === "initialize") {
      answer({ protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: "1.5.12" },
        agentCapabilities: { loadSession: true, auth: { logout: {} }, sessionCapabilities: { resume: {} } },
        authMethods: [{ id: "oauth-personal", name: "Google account" }] });
    } else if (method === "authenticate" && !existsSync(authenticated)) {
      console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603,
        message: "No browser is available here (no graphical display is available to open a browser). Run `agy acp --login` in a terminal on this machine, then retry" } }));
    } else if (method === "session/new") {
      answer({ sessionId: "fixture-antigravity-session" });
    } else answer({});
  }
}

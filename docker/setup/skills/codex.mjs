// Native metadata/settings exchanges. No thread, turn, prompt or model call.
import { spawn } from "node:child_process";

function codexRequest({ executable, home, env = process.env, timeoutMs = 6000, maxBytes = 2 * 1024 * 1024, spawnImpl = spawn, experimentalApi = false }, method, params) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, closed = false, buffer = "", bytes = 0, stage = "initialize";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const publish = () => { if (error) reject(error); else resolve(result); };
      if (child && !closed) {
        // Codex can still write logs/state after returning metadata. Do not
        // hand the home back to a caller until the process and pipes close.
        const force = setTimeout(() => child.kill("SIGKILL"), 1000);
        force.unref();
        child.once("close", () => { clearTimeout(force); publish(); });
        child.stdin?.destroy();
        child.kill();
      } else publish();
    };
    const fail = (message) => finish(new Error(message));
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    try {
      child = spawnImpl(executable, ["app-server", "--stdio"], { cwd: home, env, stdio: ["pipe", "pipe", "ignore"] });
      timer = setTimeout(() => fail("Codex skill request timed out. Refresh to check its current state."), timeoutMs);
      child.on("error", () => fail("Could not start Codex skill discovery."));
      child.stdin.on("error", () => fail("Codex closed its discovery connection."));
      child.on("close", () => { closed = true; if (!settled) fail("Codex exited before returning its skill response. Refresh to check its current state."); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) return fail("Codex skill inventory exceeded the response limit.");
        buffer += chunk;
        let end;
        while (!settled && (end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); }
          catch { return fail("Codex returned an invalid discovery response."); }
          if (!message || typeof message !== "object" || Array.isArray(message)) return fail("Codex returned an invalid discovery response.");
          if (stage === "initialize" && message.id === 1) {
            if (message.error || !message.result) return fail("This Codex version could not initialize skill discovery.");
            stage = "request";
            send({ method: "initialized" });
            send({ id: 2, method, params });
          } else if (stage === "request" && message.id === 2) {
            if (message.error || !message.result || typeof message.result !== "object" || Array.isArray(message.result)) {
              if (experimentalApi) return finish(Object.assign(new Error(method === "config/batchWrite" ? "Codex could not save hook settings. Refresh and review the hooks again." : "This Codex version could not read plugin hooks and their settings."), { code: method === "config/batchWrite" ? "conflict" : "unsupported" }));
              return fail(method === "skills/list" ? "This Codex version could not list skills." : "Codex could not save skill availability. Refresh to check its current state.");
            }
            finish(null, message.result);
          } else if (message.id !== undefined && message.method) {
            // Discovery cannot approve an action or service provider tool calls.
            return fail("Codex requested an unexpected action during skill discovery.");
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "t3-setup-skills", version: "1.0.0" }, ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}) } });
    } catch {
      fail("Could not start Codex skill discovery.");
    }
  });
}

export async function listCodexSkills(options) {
  const result = await codexRequest(options, "skills/list", { cwds: [options.home], forceReload: true });
  const entry = result.data?.find?.((item) => item?.cwd === options.home);
  if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) throw new Error("Codex returned an incomplete skill inventory.");
  return entry;
}

export async function writeCodexSkillConfig(options) {
  const result = await codexRequest(options, "skills/config/write", { path: options.path, enabled: options.enabled });
  if (typeof result.effectiveEnabled !== "boolean" || result.effectiveEnabled !== options.enabled) {
    throw new Error("Codex did not confirm the requested availability. Refresh to check its current state.");
  }
  return result;
}

export async function listCodexHooks(options) {
  const native = { ...options, experimentalApi: true };
  const result = await codexRequest(native, "hooks/list", { cwds: [options.home] });
  const entry = result.data?.find?.(item => item?.cwd === options.home);
  if (!entry || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || !Array.isArray(entry.warnings)) throw new Error("Codex returned an incomplete hook inventory.");
  const config = await codexRequest(native, "config/read", { includeLayers: true });
  const user = config.layers?.find(layer => layer.name?.type === "user" && [options.configPath, options.resolvedConfigPath].includes(layer.name.file));
  if (!user || typeof user.version !== "string") throw new Error("Codex could not verify the user hook settings revision.");
  return { ...entry, configVersion: user.version };
}

export async function writeCodexHookConfig(options) {
  const key = "hooks.state." + JSON.stringify(options.key);
  const edits = options.action === "trust" ? [{ keyPath: key + ".trusted_hash", value: options.currentHash, mergeStrategy: "replace" }]
    : [{ keyPath: key + ".enabled", value: options.action === "enable", mergeStrategy: "replace" }];
  const result = await codexRequest({ ...options, experimentalApi: true }, "config/batchWrite", {
    edits, filePath: options.resolvedConfigPath, expectedVersion: options.configVersion,
  });
  if (result.status !== "ok" || result.filePath !== options.resolvedConfigPath) throw new Error("Codex did not confirm the hook setting. Refresh to check its state.");
  return result;
}

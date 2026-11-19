export const files = [
  "packages/shared/src/nodeRuntime.ts",
  "apps/server/src/provider/antigravityAuthSupport.ts",
];

export function patchAntigravityRuntime(source) {
  const next = { ...source };
  const change = (file, before, after) => {
    if (typeof next[file] !== "string" || next[file].split(before).length !== 2) {
      throw new Error(`The Antigravity runtime patch no longer matches ${file}. Review the upstream source before publishing.`);
    }
    next[file] = next[file].replace(before, after);
  };

  change(files[0], `  const env = environment ?? (yield* HostProcess.Environment);
  const resolvedNodePath = yield* resolveCommandPath(platform === "win32" ? "node.exe" : "node", {`,
  `  const hostEnv = yield* HostProcess.Environment;
  const env = environment ?? hostEnv;
  // Login-shell PATH can prefer a Mise shim with no selected Node version.
  const imageNode = hostEnv.T3_INFRA_NODE;
  const defaultCommand = platform === "win32" ? "node.exe" : "node";
  const command =
    platform === "linux" &&
    (feature === "Antigravity" || feature === "Antigravity sign-in") &&
    imageNode && path.isAbsolute(imageNode)
      ? imageNode
      : defaultCommand;
  const resolvedNodePath = yield* resolveCommandPath(command, {`);

  change(files[1], '  "ELECTRON_RUN_AS_NODE",', `  "ELECTRON_RUN_AS_NODE",
  // These children do not receive the server's launcher IPC socket.
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",`);
  return next;
}

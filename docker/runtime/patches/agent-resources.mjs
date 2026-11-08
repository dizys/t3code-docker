import { readFileSync } from 'node:fs';
export const files = ['apps/server/src/provider/antigravityAuthSupport.ts', 'packages/provider-cursor/src/server/driver.ts'];
export const creates = ['apps/server/src/provider/antigravityUserResources.ts', 'packages/provider-cursor/src/server/globalInstructions.ts'];
export const assets = [new URL('./antigravity-user-resources.ts', import.meta.url), new URL('./cursor-global-instructions.ts', import.meta.url)];
export function patchAgentResources(source) {
  const next = { ...source };
  for (let i = 0; i < creates.length; i++) {
    if (Object.hasOwn(next, creates[i])) throw new Error('An agent resource bridge already exists upstream. Review it before publishing.');
    next[creates[i]] = readFileSync(assets[i], 'utf8');
  }
  const change = (file, before, after) => {
    if (typeof next[file] !== 'string' || next[file].split(before).length !== 2) throw new Error(`The agent-resources patch no longer matches ${file}. Review the upstream source before publishing this runtime.`);
    next[file] = next[file].replace(before, after);
  };
  change(files[0], 'import * as NodeFSP from "node:fs/promises";', 'import * as NodeFSP from "node:fs/promises";\nimport { linkAntigravityUserResources } from "./antigravityUserResources.ts";');
  change(files[0], '  yield* linkAntigravityUserSkills({ profileDirectory: geminiHome, userHome, platform });', `  yield* linkAntigravityUserSkills({ profileDirectory: geminiHome, userHome, platform });
  yield* Effect.tryPromise(() => linkAntigravityUserResources(geminiHome, userHome)).pipe(
    Effect.mapError((error) => authSupportError(error instanceof Error ? error.message : "Antigravity global instructions and MCP settings could not be linked into its T3 profile.")),
  );`);
  change(files[1], 'import * as CursorAgentSdk from "./CursorAgentSdk.ts";', 'import * as CursorAgentSdk from "./CursorAgentSdk.ts";\nimport { withCursorGlobalInstructions } from "./globalInstructions.ts";');
  change(files[1], '.open({ ...input, options: { ...input.options, apiKey } })', '.open({ ...input, options: withCursorGlobalInstructions({ ...input.options, apiKey }, processEnv) })');
  return next;
}

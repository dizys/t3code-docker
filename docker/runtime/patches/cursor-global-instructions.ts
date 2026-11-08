// The SDK loads rules from each local workspace. A dedicated additional
// workspace supplies global guidance without modifying project files or
// replacing Cursor's built-in system prompt.
import type { AgentOptions } from "@cursor/sdk";
import { existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export function withCursorGlobalInstructions(options: AgentOptions, env: NodeJS.ProcessEnv): AgentOptions {
  const home = env.HOME || homedir();
  const root = path.join(home, ".cursor");
  const directory = path.join(root, "t3-instructions");
  if (!options.local || !existsSync(path.join(directory, "AGENTS.md"))) return options;
  return { ...options, local: { ...options.local, dirs: [...new Set([...(options.local.dirs || []), directory])] } };
}

// Launchers: what T3 Code's `binaryPath` points at for a managed agent.
//
// T3 Code offers its own "Update now" for a provider only when it can tell
// from the executable's path who installed it (src/provider/
// providerMaintenance.ts in T3 Code 0.0.45): Claude's native installer
// (`…/.local/bin/claude`), Codex's standalone tree (`…/packages/standalone/…`),
// OpenCode's (`…/.opencode/bin/opencode`), or an npm, bun, pnpm or Homebrew
// install. It refuses a mise install outright, so that it never runs a
// package manager against an install it did not create. Grok it offers
// `<path> update` for wherever it is, which, pointed at the mise install, ran
// Grok's own updater over it behind the manager's back. (Its rule for Cursor
// is the same, though 0.0.45 reports no update for it here; Cursor's launcher
// is ready for when it does.)
//
// A launcher is a two-line script at a path of the shape T3 recognises. It
// runs the exact executable the harness manager installed, with whatever
// arguments it was given, except the one call T3 makes to update it (`update`,
// or OpenCode's `upgrade`, alone), which it hands to `t3-harness update <id>`:
// the same managed update as the setup page's, under its lock, with its exact
// version record and rollback. That update syncs the provider settings, which
// writes the launcher again for the new release, so T3's check after the
// update finds the version it moved to.
//
// Only T3's `binaryPath` points here. `claude` in a terminal is still the mise
// shim, and its own `claude update` is untouched.
import path from "node:path";

/**
 * Where each agent's launcher goes, under the launcher directory: a path T3's
 * check for that provider accepts, ending in the agent's own command name.
 * `update` is the arguments T3 runs it with to update it.
 */
export const LAUNCHERS = Object.freeze({
  claude: { path: ["claude", ".local", "bin", "claude"], update: ["update"] },
  codex: { path: ["codex", "packages", "standalone", "codex"], update: ["update"] },
  opencode: { path: ["opencode", ".opencode", "bin", "opencode"], update: ["upgrade"] },
  grok: { path: ["grok", "grok"], update: ["update"] },
  cursor: { path: ["cursor", "cursor-agent"], update: ["update"] },
});

/** The launcher directory: beside the harness manager's own links. */
export function launcherDirFor(env = {}, home) {
  const explicit = typeof env.T3_LAUNCHER_DIR === "string" ? env.T3_LAUNCHER_DIR.trim() : "";
  return explicit || path.join(home, ".local", "share", "t3-harness", "launchers");
}

/** One agent's launcher path, or null for an id without one. */
export function launcherPathFor(dir, id) {
  const launcher = LAUNCHERS[id];
  return launcher ? path.join(dir, ...launcher.path) : null;
}

/** A word for sh, whatever it holds. */
const quote = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

/**
 * The launcher for one agent: run `executable`, except T3's update call,
 * which goes to `harnessCli update <id>`.
 */
export function launcherScript({ id, name, executable, harnessCli }) {
  const launcher = LAUNCHERS[id];
  if (!launcher) throw new Error(`no launcher for ${id}`);
  const update = launcher.update;
  const isUpdate = [`[ "$#" -eq ${update.length} ]`, ...update.map((arg, index) => `[ "$${index + 1}" = ${quote(arg)} ]`)].join(" && ");
  return [
    "#!/bin/sh",
    `# ${name} for T3 Code, written by the setup service: runs the release the`,
    "# setup page installed. T3 Code's own Update runs this with",
    `# \`${update.join(" ")}\`, which updates it the setup page's way. Rewritten on every`,
    "# install and update; edits here do not last.",
    `if ${isUpdate}; then exec ${quote(harnessCli)} update ${quote(id)}; fi`,
    `exec ${quote(executable)} "$@"`,
    "",
  ].join("\n");
}

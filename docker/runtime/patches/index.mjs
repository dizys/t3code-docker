import * as opencodeSkills from "./opencode-skills.mjs";
import * as projectDirectory from "./project-directory.mjs";
import * as setupPalette from "./setup-palette.mjs";

// Included in the registry fingerprint. Bump when the build contract changes.
export const BUILD_REVISION = 4;
export const patches = [{ name: "project-directory", module: new URL("./project-directory.mjs", import.meta.url), files: projectDirectory.files, apply: projectDirectory.patchProjectDirectory },
  { name: "opencode-skills", module: new URL("./opencode-skills.mjs", import.meta.url), files: opencodeSkills.files, apply: opencodeSkills.patchOpenCodeSkills },
  { name: "setup-palette", module: new URL("./setup-palette.mjs", import.meta.url), files: setupPalette.files, creates: setupPalette.creates, assets: setupPalette.assets, apply: setupPalette.patchSetupPalette }];
export const files = [...new Set(patches.flatMap((patch) => patch.files))];
export const createdFiles = [...new Set(patches.flatMap((patch) => patch.creates ?? []))];
export const applySourcePatches = (source) => patches.reduce((current, patch) => patch.apply(current), source);

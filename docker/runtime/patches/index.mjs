import * as projectDirectory from "./project-directory.mjs";

// Included in the registry fingerprint. Bump when the build contract changes.
export const BUILD_REVISION = 1;
export const patches = [{ name: "project-directory", module: new URL("./project-directory.mjs", import.meta.url), files: projectDirectory.files, apply: projectDirectory.patchProjectDirectory }];
export const files = [...new Set(patches.flatMap((patch) => patch.files))];
export const applySourcePatches = (source) => patches.reduce((current, patch) => patch.apply(current), source);

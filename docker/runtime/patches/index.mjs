import * as agentResources from "./agent-resources.mjs";
import * as opencodeSkills from "./opencode-skills.mjs";
import * as projectDirectory from "./project-directory.mjs";
import * as setupPalette from "./setup-palette.mjs";
import * as gatewayCapabilities from "./gateway-capabilities.mjs";
import * as gatewayContext from "./gateway-context.mjs";
import * as gatewayQuota from "./gateway-quota.mjs";

// Included in the registry fingerprint. Bump when the build contract changes.
export const BUILD_REVISION = 5;
export const patches = [{ name: "agent-resources", module: new URL("./agent-resources.mjs", import.meta.url), files: agentResources.files, creates: agentResources.creates, assets: agentResources.assets, apply: agentResources.patchAgentResources },
  { name: "project-directory", module: new URL("./project-directory.mjs", import.meta.url), files: projectDirectory.files, apply: projectDirectory.patchProjectDirectory },
  { name: "gateway-capabilities", module: new URL("./gateway-capabilities.mjs", import.meta.url), files: gatewayCapabilities.files, apply: gatewayCapabilities.patchGatewayCapabilities },
  { name: "gateway-context", module: new URL("./gateway-context.mjs", import.meta.url), files: gatewayContext.files, creates: gatewayContext.creates, assets: gatewayContext.assets, apply: gatewayContext.patchGatewayContext },
  { name: "gateway-quota", module: new URL("./gateway-quota.mjs", import.meta.url), files: gatewayQuota.files, creates: gatewayQuota.creates, assets: gatewayQuota.assets, apply: gatewayQuota.patchGatewayQuota },
  { name: "opencode-skills", module: new URL("./opencode-skills.mjs", import.meta.url), files: opencodeSkills.files, apply: opencodeSkills.patchOpenCodeSkills },
  { name: "setup-palette", module: new URL("./setup-palette.mjs", import.meta.url), files: setupPalette.files, creates: setupPalette.creates, assets: setupPalette.assets, apply: setupPalette.patchSetupPalette }];
export const files = [...new Set(patches.flatMap((patch) => patch.files))];
export const createdFiles = [...new Set(patches.flatMap((patch) => patch.creates ?? []))];
export const applySourcePatches = (source) => patches.reduce((current, patch) => patch.apply(current), source);

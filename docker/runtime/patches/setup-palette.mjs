import { readFileSync } from "node:fs";

export const files = ["apps/web/src/components/CommandPalette.tsx"];
export const clientFile = "apps/web/src/components/SetupPaletteActions.ts";
export const creates = [clientFile];
export const assets = [new URL("./setup-palette-client.ts", import.meta.url)];
export const clientSource = readFileSync(assets[0], "utf8");

function replaceOnce(text, before, after) {
  if (typeof text !== "string" || text.split(before).length !== 2) {
    throw new Error("The setup-palette patch no longer matches CommandPalette.tsx. Review the upstream source before publishing this runtime.");
  }
  return text.replace(before, after);
}

export function patchSetupPalette(source) {
  if (Object.hasOwn(source, clientFile)) throw new Error("The setup-palette client already exists. Review the upstream source before publishing this runtime.");
  let text = source[files[0]];
  text = replaceOnce(text, 'import { useAvailableSettingsSearchItems }',
    'import { useSetupPaletteActions } from "./SetupPaletteActions";\nimport { useAvailableSettingsSearchItems }');
  text = replaceOnce(text, '  const isActionsOnly = deferredQuery.startsWith(">");',
    '  const isActionsOnly = deferredQuery.startsWith(">");\n  const setupActions = useSetupPaletteActions(deferredQuery, async () => {\n    await navigate({ to: "/settings" });\n  });');
  text = replaceOnce(text, '  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });',
    '  actionItems.push(...setupActions);\n  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });');
  return { ...source, [files[0]]: text, [clientFile]: clientSource };
}

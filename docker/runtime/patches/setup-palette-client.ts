// Image-owned Setup metadata enters the native command pipeline here. The
// native palette owns matching, ordering, virtualization, focus and execution.
import { createElement, useSyncExternalStore } from "react";
import { SettingsIcon } from "lucide-react";
import type { CommandPaletteActionItem } from "./CommandPalette.logic";

declare global {
  interface Window {
    __T3_SETUP_PALETTE_NATIVE__?: 1;
    __T3_SETUP_PALETTE_SNAPSHOT__?: unknown;
  }
}

type IconNode = readonly [string, Readonly<Record<string, string>>];
interface SetupCommand {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly terms: ReadonlyArray<string>;
  readonly icon: ReadonlyArray<IconNode> | null;
}

const EMPTY: ReadonlyArray<SetupCommand> = Object.freeze([]);
const CHANGED = "t3-setup-palette:changed";
const key = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const text = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const tags = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
const attributes = new Set(["d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "points", "fill"]);

function readIcon(value: unknown): ReadonlyArray<IconNode> | null {
  if (!Array.isArray(value) || !value.length || value.length > 128) return null;
  const nodes: IconNode[] = [];
  for (const node of value) {
    if (!Array.isArray(node) || node.length !== 2 || !tags.has(node[0]) || !record(node[1])) return null;
    const props: Record<string, string> = {};
    for (const [name, value] of Object.entries(node[1])) {
      if (!attributes.has(name) || typeof value !== "string" || !/^[-0-9a-zA-Z .,]{1,2000}$/.test(value)
        || name === "fill" && value !== "none" && value !== "currentColor") return null;
      props[name] = value;
    }
    nodes.push([node[0], props]);
  }
  return nodes;
}

// Cached snapshots are required by useSyncExternalStore. Validate only when
// the bridge replaces its data; never accept HTML, callbacks or destinations.
let previous: unknown;
let commands = EMPTY;
function getSnapshot(): ReadonlyArray<SetupCommand> {
  const value = typeof window === "undefined" ? undefined : window.__T3_SETUP_PALETTE_SNAPSHOT__;
  if (value === previous) return commands;
  previous = value;
  commands = EMPTY;
  if (!record(value) || value.protocol !== 1 || !Array.isArray(value.items) || value.items.length > 101
    || !record(value.icons) || Object.keys(value.icons).length > 100) return commands;
  const seen = new Set<string>();
  const next: SetupCommand[] = [];
  for (const item of value.items) {
    if (!record(item) || !key(item.id) || seen.has(item.id) || !text(item.title) || !item.title
      || !text(item.meta, 500) || !key(item.icon) || !Array.isArray(item.terms)
      || item.terms.length > 25 || !item.terms.every(term => text(term))) return commands;
    seen.add(item.id);
    next.push({ id: item.id, title: item.title, meta: item.meta, terms: [...item.terms], icon: readIcon(value.icons[item.icon]) });
  }
  commands = next;
  return commands;
}

function subscribe(changed: () => void): () => void {
  window.addEventListener(CHANGED, changed);
  return () => window.removeEventListener(CHANGED, changed);
}

if (typeof window !== "undefined") {
  window.__T3_SETUP_PALETTE_NATIVE__ = 1;
  window.dispatchEvent(new Event("t3-setup-palette:ready"));
}

export function useSetupPaletteActions(
  query: string,
  openSettings: () => Promise<unknown>,
): ReadonlyArray<CommandPaletteActionItem> {
  const items = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  // Root browsing gets one entry. Searching (including > commands-only)
  // exposes every destination to T3's matcher, with no separate search rules.
  return items.filter(item => query.trim().length > 0 || item.id === "setup").map<CommandPaletteActionItem>(item => ({
    kind: "action",
    value: `t3-setup:${item.id}`,
    title: item.title,
    description: item.meta,
    searchTerms: [item.title, `Setup ${item.title}`, ...item.terms, item.meta],
    icon: createElement("span", { className: "contents", "data-t3-setup-command": item.id }, item.icon
      ? createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2,
          strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "size-4 shrink-0" },
          ...item.icon.map(([tag, props], index) => createElement(tag, { ...props, key: index })))
      : createElement(SettingsIcon, { className: "size-4 shrink-0" })),
    run: async () => {
      const detail = { protocol: 1, id: item.id };
      const request = new CustomEvent("t3-setup-palette:request", { detail, cancelable: true });
      window.dispatchEvent(request);
      // The bridge acknowledges only an authenticated, still-current command.
      if (!request.defaultPrevented) return;
      await openSettings();
      window.dispatchEvent(new CustomEvent("t3-setup-palette:open", { detail }));
    },
  }));
}

import { existsSync } from "node:fs";
const local = new URL("../harness/service-references.mjs", import.meta.url);
const api = await import(existsSync(local) ? local.href : "file:///opt/t3-harness/service-references.mjs");
export const { serviceReferences } = api;

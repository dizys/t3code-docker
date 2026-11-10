import { existsSync } from "node:fs";
const local = new URL("../services/client.mjs", import.meta.url);
const api = await import(existsSync(local) ? local.href : "file:///opt/t3-services/client.mjs");
export const { createServicesAPI, SERVICE_ROUTES } = api;

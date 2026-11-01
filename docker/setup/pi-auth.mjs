// Shared Pi credential contract; image setup and harness live in separate /opt trees.
import { existsSync } from 'node:fs';
const local = new URL('../harness/pi-auth.mjs', import.meta.url);
const shared = await import(existsSync(local) ? local.href : 'file:///opt/t3-harness/pi-auth.mjs');
export const { PI_KEY_PROVIDERS, createPiAuth, isPiProviderId, piProviderName, piAuthFile } = shared;

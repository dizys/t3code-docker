// Services and Setup ship in sibling /opt/t3-* directories in the image.
// Share the Vault's variants while also supporting the source-tree layout.
import { existsSync } from 'node:fs';
const source = new URL('../setup/credentials/redact.mjs', import.meta.url);
const installed = new URL('../t3-setup/credentials/redact.mjs', import.meta.url);
export const { maskValues } = await import(existsSync(source) ? source.href : installed.href);

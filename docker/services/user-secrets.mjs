import { existsSync } from "node:fs";
import { ServiceError } from "./store.mjs";
// The installed layout and repository layout share the exact same Vault API.
const source = existsSync("/opt/t3-setup/credentials.mjs") ? "/opt/t3-setup/credentials.mjs" : new URL("../setup/credentials.mjs", import.meta.url).pathname;
export async function resolveSecrets(definition, { home, stateHome }) {
  if (!Object.keys(definition.secrets || {}).length) return { env: {}, masks: [], receipts: [] };
  const { createCredentialStore } = await import(source);
  const store = createCredentialStore({ directory: stateHome + "/server-credentials", home, readOnly: true });
  const env = {}, masks = [], receipts = [];
  for (const [name, id] of Object.entries(definition.secrets)) {
    let credential;
    try { credential = await store.forUse(id); } catch { throw new ServiceError("credential-unavailable", `The Vault reference for ${name} is unavailable. Choose a saved token.`, "secrets"); }
    // File, SSH and multi-field credentials need their own explicit contract.
    if (credential.type !== "token" || typeof credential.secrets?.token !== "string") throw new ServiceError("invalid", "Service environment references currently accept saved Token credentials.", "secrets");
    env[name] = credential.secrets.token;
    masks.push(credential.secrets.token);
    receipts.push({ name, id, revision: credential.revision });
  }
  return { env, masks, receipts };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { protectedPath, protectedDirectory, protectedWrite } from "./artifacts.mjs";
const exec = promisify(execFile);
const systemEnv = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const command = (file, args, options = {}) => exec(file, args, { env: systemEnv, timeout: 10000, maxBuffer: 65536, ...options });

export async function publicKeys(keys, { run = null } = {}) {
  const result = [], seen = new Set();
  for (const input of keys) {
    // No authorized_keys options, private-key blocks or embedded newlines.
    const key = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: ([^\r\n]{0,200}))?$/.exec(input.trim());
    if (!key) throw new ServiceError("invalid", /PRIVATE KEY/.test(input) ? "This is a private key. Paste only its public key." : "Paste one supported public key per entry, without authorized_keys options.", "keys");
    const blob = Buffer.from(key[2], "base64"), typeSize = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
    if (!typeSize || typeSize > 80 || blob.subarray(4, 4 + typeSize).toString() !== key[1]) throw new ServiceError("invalid", "That public key could not be parsed.", "keys");
    const normalized = key[1] + " " + key[2];
    let bits;
    if (run) { const { stdout } = await run("/usr/bin/ssh-keygen", ["-lf", "/dev/stdin"], { input: normalized }); bits = Number(stdout.split(" ")[0]); }
    else {
      // ssh-keygen seeks while parsing, so a pipe is insufficient. Only an
      // already validated public blob reaches this exclusively created file.
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "t3-public-key-"));
      try {
        await fs.writeFile(scratch + "/key", normalized + "\n", { flag: "wx", mode: 0o600 });
        bits = Number((await command("/usr/bin/ssh-keygen", ["-lf", scratch + "/key"])).stdout.split(" ")[0]);
      } catch { bits = 0; }
      finally { await fs.rm(scratch, { recursive: true, force: true }); }
    }
    if (!bits || key[1] === "ssh-rsa" && bits < 2048) throw new ServiceError("invalid", "Use a valid Ed25519, ECDSA or RSA key of at least 2048 bits.", "keys");
    const fingerprint = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint); result.push({ publicKey: normalized + (key[3] ? " " + key[3] : ""), fingerprint, type: key[1], bits });
  }
  return result;
}
export async function deriveHostPublicKey(file) {
  // ssh-keygen can include the private key's comment. Identity comparisons and
  // recovered public sidecars use only the key type and encoded public blob.
  try { return (await command("/usr/bin/ssh-keygen", ["-y", "-f", file])).stdout.trim().split(/\s+/).slice(0, 2).join(" "); }
  catch { throw new ServiceError("identity", "The existing SSH host identity cannot be read. It was preserved; restore its protected backup."); }
}
async function identity(root) {
  const directory = path.join(root, "instances/openssh/identity");
  await protectedDirectory(directory);
  const key = path.join(directory, "ed25519");
  let exists = true;
  try { await protectedPath(key, { directory: false }); } catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
  if (!exists) {
    try { await fs.lstat(key + ".pub"); throw new ServiceError("identity", "The private host identity is missing. Restore its protected backup before enabling SSH."); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const tmp = path.join(directory, ".new-" + randomUUID());
    await command("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", tmp]);
    const handle = await fs.open(tmp, "r"); await handle.sync(); await handle.close();
    await fs.rename(tmp, key); await fs.rename(tmp + ".pub", key + ".pub");
    const dir = await fs.open(directory, "r"); await dir.sync(); await dir.close();
  }
  const derived = await deriveHostPublicKey(key);
  try {
    await protectedPath(key + ".pub", { directory: false });
    const current = await fs.readFile(key + ".pub", "utf8");
    if (current.trim().split(/\s+/).slice(0, 2).join(" ") !== derived) throw new ServiceError("identity", "The host key and public sidecar do not match. Restore the existing identity.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(key + ".pub", derived + "\n", { flag: "wx", mode: 0o644 });
  }
  return { key, fingerprint: "SHA256:" + createHash("sha256").update(Buffer.from(derived.split(" ")[1], "base64")).digest("base64").replace(/=+$/, "") };
}
export async function configureSystem(resource, p) {
  const id = resource.id, config = resource.config, artifact = resource.artifact;
  await protectedPath(artifact.path);
  const instance = path.join(p.root, "instances", id);
  await protectedDirectory(instance);
  if (id === "openssh") {
    const { stdout } = await command("/usr/bin/id", ["-u", "t3"]);
    if (!Number(stdout.trim())) throw new ServiceError("account", "SSH cannot use a root account. Select a nonzero PUID and recreate this container.");
    const host = await identity(p.root), keys = await publicKeys(config.keys);
    const runtime = "/run/t3code-services";
    await protectedPath(runtime);
    await protectedWrite(runtime + "/ssh-authorized-keys", keys.map(key => key.publicKey).join("\n") + "\n", 0o644);
    const file = instance + "/sshd_config";
    const settings = `Port ${config.port}\nAddressFamily inet\nListenAddress ${config.listen}\nHostKey ${host.key}\nPidFile none\nAuthorizedKeysFile ${runtime}/ssh-authorized-keys\nSshdSessionPath ${artifact.path}/usr/lib/openssh/sshd-session\nSshdAuthPath ${artifact.path}/usr/lib/openssh/sshd-auth\nStrictModes yes\nPubkeyAuthentication yes\nAuthenticationMethods publickey\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers t3\nAllowTcpForwarding yes\nGatewayPorts no\nPermitTTY yes\nX11Forwarding no\nAllowAgentForwarding no\nPermitTunnel no\nUsePAM no\nPermitUserEnvironment no\nPrintMotd no\nSubsystem sftp internal-sftp\nLogLevel INFO\n`;
    await protectedWrite(file, settings);
    const cmd = await systemCommand(resource, p);
    try { await command(cmd.executable, ["-t", "-f", file], { env: cmd.env }); }
    catch { throw new ServiceError("configuration", "OpenSSH could not validate its dependencies, account or configuration. The previous configuration was retained for recovery."); }
    return { hostFingerprint: host.fingerprint, keys: keys.map(({ fingerprint, type, bits }) => ({ fingerprint, type, bits })) };
  }
  if (id === "cloudflared") {
    if (config.token) await protectedWrite(instance + "/token", config.token);
    await protectedPath(instance + "/token", { directory: false });
  }
  return id === 'tailscale' ? { ...resource.details } : {};
}
export async function systemCommand(resource, p) {
  const { id, artifact, config } = resource;
  if (!artifact?.path?.startsWith(p.root + "/artifacts/")) throw new ServiceError("artifact", "Install the verified service payload first.");
  await protectedPath(artifact.path);
  const env = { ...systemEnv, LD_LIBRARY_PATH: artifact.path + "/usr/lib/" + (process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu") };
  const instance = path.join(p.root, "instances", id);
  if (id === "openssh") return { executable: artifact.path + "/usr/sbin/sshd", argv: ["-D", "-e", "-f", instance + "/sshd_config"], env };
  if (id === "tailscale") return { executable: artifact.path + "/tailscaled", argv: ["--tun=userspace-networking", "--state=" + instance + "/tailscaled.state", "--socket=/run/t3code-services/tailscale.sock", "--statedir=" + instance], env };
  if (id === "cloudflared") {
    const token = await fs.readFile(instance + "/token", "utf8");
    return { executable: artifact.path + "/cloudflared", argv: ["tunnel", "--no-autoupdate", "run", "--token-file", instance + "/token"], env, masks: [token] };
  }
  throw new ServiceError("invalid", "Unknown system service.");
}
export async function tailscaleStatus(resource) {
  try {
    const { stdout } = await command(resource.artifact.path + "/tailscale", ["--socket=/run/t3code-services/tailscale.sock", "status", "--json"]);
    const result = JSON.parse(stdout);
    return { state: result.BackendState, ips: result.TailscaleIPs || [], dnsName: result.Self?.DNSName || null, authUrl: typeof result.AuthURL === "string" && /^https:\/\/(?:login\.tailscale\.com|controlplane\.tailscale\.com)\//.test(result.AuthURL) ? result.AuthURL : null };
  } catch { return { state: "Unavailable", ips: [], dnsName: null, authUrl: null }; }
}

export async function controlTailscale(resource, action, configuration = {}) {
  const cli = resource.artifact.path + '/tailscale';
  await protectedPath(cli, { directory: false });
  const invoke = args => command(cli, ['--socket=/run/t3code-services/tailscale.sock', ...args], { timeout: 12000 });
  if (action === 'sign-in') {
    const state = await tailscaleStatus(resource);
    // Reattach to an existing ceremony after controller/container restart.
    if (state.state === 'Running' || state.authUrl) return { authGeneration: Date.now() };
    try { await invoke(['up', '--hostname=' + resource.config.hostname, '--accept-dns=false', '--accept-routes=false', '--timeout=5s']); }
    catch { /* up times out normally while waiting for browser sign-in. */ }
    const after = await tailscaleStatus(resource);
    if (!after.authUrl && after.state !== 'Running') throw new ServiceError('authentication', 'Tailnet sign-in could not start. Check connector status before retrying.');
    return { authGeneration: Date.now() };
  }
  if (action === 'sign-out') {
    if ((await tailscaleStatus(resource)).state === 'NeedsLogin') return { authGeneration: Date.now() };
    await invoke(['logout']);
    return { authGeneration: Date.now() };
  }
  if ((await tailscaleStatus(resource)).state !== 'Running') throw new ServiceError('authentication', 'Sign in to this tailnet connector before configuring inbound TCP forwarding.');
  const { listenPort, targetPort } = configuration;
  try { await invoke(action === 'serve' ? ['serve', '--bg', '--tcp=' + listenPort, 'tcp://127.0.0.1:' + targetPort] : ['serve', '--tcp=' + listenPort, 'off']); }
  catch { throw new ServiceError('forwarding', 'Tailnet TCP forwarding was not applied. Check tailnet Serve permission and connector status.'); }
  const existing = resource.details?.forwarding || [];
  return { forwarding: [...existing.filter(item => item.listenPort !== listenPort), ...(action === 'serve' ? [{ listenPort, targetPort }] : [])] };
}

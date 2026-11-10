// Build-time only. apt has authenticated its package indexes. The resulting
// exact URLs and SHA-256 digests are image-owned authority, not a writable
// online catalogue. No maintainer script or downloaded executable runs here.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [output, tailscale = "1.104.5", cloudflared = "2026.5.2"] = process.argv.slice(2);
const arch = execFileSync("/usr/bin/dpkg", ["--print-architecture"], { encoding: "utf8" }).trim();
if (!["amd64", "arm64"].includes(arch)) throw new Error("Unsupported optional service architecture");
const entries = [];
for (const name of ["openssh-server", "libwrap0", "libwtmpdb0", "libtalloc2"]) {
  const info = execFileSync("/usr/bin/apt-cache", ["show", "--no-all-versions", name], { encoding: "utf8" });
  const field = key => new RegExp("^" + key + ": (.+)$", "m").exec(info)?.[1];
  const version = field("Version"), digest = field("SHA256"), size = Number(field("Size"));
  const uris = execFileSync("/usr/bin/apt-get", ["--print-uris", "download", `${name}=${version}`], { encoding: "utf8" });
  const url = /'(https?:\/\/[^']+)'/.exec(uris)?.[1]?.replace(/^http:/, "https:");
  if (!url || !/^[a-f0-9]{64}$/.test(digest) || !size) throw new Error("Incomplete authenticated package metadata");
  entries.push({ name, version, url, sha256: digest, bytes: size, format: "deb" });
}
async function payload(url, name, format, extra = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("Optional service metadata input unavailable: " + name);
  const data = Buffer.from(await response.arrayBuffer());
  return { name, url, format, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), ...extra };
}
const tail = await payload(`https://pkgs.tailscale.com/stable/tailscale_${tailscale}_${arch}.tgz`, "tailscale", "tgz", { prefix: `tailscale_${tailscale}_${arch}` });
const cloud = await payload(`https://github.com/cloudflare/cloudflared/releases/download/${cloudflared}/cloudflared-linux-${arch}`, "cloudflared", "binary");
const catalogue = { schema: 1, revision: 1, arch, baseline: "debian-trixie", trust: "image-pinned", services: {
  openssh: { id: "openssh", name: "SSH", version: entries[0].version, payloads: entries, executable: "usr/sbin/sshd" },
  tailscale: { id: "tailscale", name: "Tailscale", version: tailscale, payloads: [tail], executable: "tailscaled" },
  cloudflared: { id: "cloudflared", name: "Cloudflare Tunnel", version: cloudflared, payloads: [cloud], executable: "cloudflared" },
} };
writeFileSync(output, JSON.stringify(catalogue, null, 2) + "\n", { mode: 0o644 });

import net from "node:net";
import http from "node:http";
export async function checkHealth(health, { ssh = false } = {}) {
  if (health.kind === "process") return { ok: true, kind: "process", message: "Running. No application health check configured.", at: Date.now() };
  const ok = await new Promise(resolve => {
    let settled = false;
    const done = value => { if (settled) return; settled = true; resolve(value); };
    if (health.kind === "http") {
      const req = http.get({ hostname: "127.0.0.1", port: health.port, path: health.path, timeout: 2000, headers: { connection: "close" }, maxHeaderSize: 8192 }, res => { done(res.statusCode >= 200 && res.statusCode < 300); res.destroy(); });
      req.on("timeout", () => { req.destroy(); done(false); }); req.on("error", () => done(false));
    } else {
      const socket = net.createConnection({ host: "127.0.0.1", port: health.port });
      socket.setTimeout(2000);
      socket.on("connect", () => { if (!ssh) { done(true); socket.destroy(); } });
      socket.once("data", data => { done(data.toString("ascii").startsWith("SSH-2.0-")); socket.destroy(); });
      socket.on("timeout", () => { done(false); socket.destroy(); }); socket.on("error", () => done(false));
      socket.on("close", () => done(false));
    }
  });
  return { ok, kind: health.kind, at: Date.now(), message: ok ? "Local endpoint answered." : "Local endpoint did not pass its health check." };
}

// T3 Code's own API, for the few things only T3 can do.
//
// Antigravity is not a CLI the harness manager installs: T3 Code downloads
// Google's runtime itself, pinned to the release it supports and checked
// against its checksum, and owns the Google sign-in. The console drives those
// through the same API T3's own settings page uses, so T3 stays the owner and
// its checks apply.
//
// The API is Effect RPC over T3's /ws WebSocket, JSON-encoded. A call is a
// `Request`, answered by an `Exit`; a subscription is answered by `Chunk`s,
// each of which the client acknowledges with `Ack`, until its `Exit`. The
// console authenticates as a bearer session of its own, issued through the
// `t3 auth` CLI for a few hours and renewed before it lapses. A sign-in belongs
// to the session that started it, so renewal only ever happens on a fresh
// connection, never under one in use.
// Native HTTP endpoints use a separate cached credential. Connect settings
// reads and renewals cannot retire the owner of a running RPC stream.
//
//   const api = createT3Api({ url, issueSession });
//   const config = await api.call("server.getConfig", {});
//   const sub = api.subscribe("provider.install.subscribe", { instanceId }, (state) => ...);
//   sub.close();

/** A failure T3 answered with, carrying its own sentence (`detail`) when it has one. */
export class T3ApiError extends Error {
  constructor(message, { tag = null, operation = null } = {}) {
    super(message);
    this.name = "T3ApiError";
    this.tag = tag;
    this.operation = operation;
  }
}

/** The sentence in an Effect RPC failure: a typed error's `detail`, or the defect. */
export function failureOf(exit) {
  const causes = Array.isArray(exit?.cause) ? exit.cause : exit?.cause ? [exit.cause] : [];
  for (const cause of causes) {
    if (cause?._tag === "Fail") {
      const error = cause.error ?? {};
      const text = error.detail ?? error.message ?? error.reason ?? error._tag ?? "T3 Code refused the request";
      return new T3ApiError(String(text).slice(0, 400), { tag: error._tag ?? null, operation: error.operation ?? null });
    }
    if (cause?._tag === "Die") {
      const defect = typeof cause.defect === "string" ? cause.defect : cause.defect?.message ?? "T3 Code failed the request";
      return new T3ApiError(String(defect).slice(0, 400), { tag: "Defect" });
    }
  }
  return new T3ApiError("T3 Code refused the request");
}

/**
 *   url            ws://127.0.0.1:3773/ws
 *   issueSession   () => Promise<{ token, sessionId, expiresAt }>
 *   revokeSession  (sessionId) => Promise<void>   (best effort, optional)
 */
export function createT3Api({
  url,
  issueSession,
  revokeSession = async () => {},
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  callTimeoutMs = 15_000,
  connectTimeoutMs = 5_000,
  idleMs = 60_000,
  renewWithinMs = 60 * 60 * 1000,
}) {
  // A Connect read must never renew/revoke the session that owns a live RPC
  // sign-in or installation stream. Each transport caches its own credential.
  const credentials = { rpc: { value: null, pending: null }, http: { value: null, pending: null } };
  let socket = null;           // the open socket, or null
  let opening = null;          // a connection on its way, shared
  let nextId = 0;
  let sessionGeneration = 0;
  let protocolVersion = null;
  let protocolDiscovery = null;
  let idleTimer = null;
  const pending = new Map();   // requestId -> { resolve, reject, timer } | { onValue, onEnd }

  const expiresAtMs = (value) => (Number.isFinite(Date.parse(value)) ? Date.parse(value) : now() + 60 * 60 * 1000);

  // T3 0.1.0 rejects a WebSocket upgrade that does not name the server's
  // orchestration protocol. Ask the public environment endpoint which one it
  // speaks, rather than hard-coding a version. Older servers simply report 1.
  const environmentUrl = () => {
    try {
      const target = new URL(url);
      if (target.protocol === "ws:") target.protocol = "http:";
      else if (target.protocol === "wss:") target.protocol = "https:";
      else return null;
      target.pathname = "/.well-known/t3/environment";
      target.search = "";
      target.hash = "";
      return target.toString();
    } catch {
      return null;
    }
  };

  const discoverProtocol = async (generation) => {
    if (protocolVersion !== null) return protocolVersion;
    protocolDiscovery ??= (async () => {
      try {
        const target = environmentUrl();
        if (!target || typeof fetchImpl !== "function") return null;
        const response = await fetchImpl(target, {
          headers: { accept: "application/json" },
          signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(2_000)
            : undefined,
        });
        if (!response?.ok) return null;
        const body = await response.json();
        return Number.isSafeInteger(body?.orchestrationProtocolVersion) ? body.orchestrationProtocolVersion : null;
      } catch {
        return null;
      }
    })();
    const found = await protocolDiscovery;
    if (generation !== sessionGeneration) return found;
    if (found === null) protocolDiscovery = null;
    else protocolVersion = found;
    return found;
  };

  const socketUrl = async (generation) => {
    try {
      const target = new URL(url);
      if (target.searchParams.has("orchestrationProtocol")) return url;
      const version = await discoverProtocol(generation);
      if (generation !== sessionGeneration) {
        throw new T3ApiError("T3 Code restarted while the console was connecting. Retry when it is ready.");
      }
      if (version === null) return url;
      target.searchParams.set("orchestrationProtocol", String(version));
      return target.toString();
    } catch (error) {
      if (error instanceof T3ApiError) throw error;
      return url;
    }
  };

  const retireSession = (value) => {
    if (value?.sessionId) void Promise.resolve().then(() => revokeSession(value.sessionId)).catch(() => {});
  };
  const assertGeneration = (generation) => {
    if (generation !== sessionGeneration) throw new T3ApiError("T3 Code restarted during this request. Retry when it is ready.");
  };

  /** Cache and serialize issuance separately for HTTP and RPC. */
  const ensureSession = async (cache, force = false, refused = null) => {
    if (cache.pending) return cache.pending;
    // Another request may already have replaced the credential that got a
    // delayed 401. Reuse its replacement rather than revoking it again.
    if (force && refused && cache.value && cache.value !== refused) return cache.value;
    if (!force && cache.value && cache.value.expiresAt - now() > renewWithinMs) return cache.value;
    const previous = cache.value;
    const generation = sessionGeneration;
    const issuing = (async () => {
      const issued = await issueSession();
      if (generation !== sessionGeneration) {
        retireSession(issued);
        assertGeneration(generation);
      }
      if (!issued?.token) throw new T3ApiError("T3 Code did not issue a session for the console");
      cache.value = { token: issued.token, sessionId: issued.sessionId ?? null, expiresAt: expiresAtMs(issued.expiresAt) };
      if (previous?.sessionId !== cache.value.sessionId) retireSession(previous);
      return cache.value;
    })();
    cache.pending = issuing;
    try { return await issuing; }
    finally { if (cache.pending === issuing) cache.pending = null; }
  };

  const settleAll = (error) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      if (entry.reject) entry.reject(error);
      else entry.onEnd?.(error);
    }
  };

  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (pending.size) return;
    idleTimer = setTimeout(() => {
      if (!pending.size && socket) {
        try { socket.close(); } catch { /* already closing */ }
      }
    }, idleMs);
    idleTimer.unref?.();
  };

  const send = (message) => socket.send(JSON.stringify(message));

  const onMessage = (event) => {
    for (const line of String(event.data).split("\n")) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message._tag === "Ping") { send({ _tag: "Pong" }); continue; }
      const entry = pending.get(String(message.requestId));
      if (message._tag === "Defect") { settleAll(new T3ApiError(String(message.defect ?? "T3 Code failed"))); continue; }
      if (!entry) continue;
      if (message._tag === "Chunk") {
        // Acknowledge first: T3 sends the next chunk once the last is taken.
        send({ _tag: "Ack", requestId: message.requestId });
        for (const value of message.values ?? []) entry.onValue?.(value);
      } else if (message._tag === "Exit") {
        pending.delete(String(message.requestId));
        clearTimeout(entry.timer);
        const ok = message.exit?._tag === "Success";
        if (entry.resolve) {
          if (ok) entry.resolve(message.exit.value);
          else entry.reject(failureOf(message.exit));
        } else {
          entry.onEnd?.(ok ? null : failureOf(message.exit));
        }
        scheduleIdle();
      }
    }
  };

  /** Open the socket, once: a refused upgrade is retried once with a fresh session. */
  const connect = () => {
    if (socket) return Promise.resolve(socket);
    opening ??= (async () => {
      let lastError = null;
      for (const fresh of [false, true]) {
        const { token } = await ensureSession(credentials.rpc, fresh);
        const targetUrl = await socketUrl(sessionGeneration);
        try {
          return await new Promise((resolve, reject) => {
            const ws = new WebSocketImpl(targetUrl, { headers: { authorization: `Bearer ${token}` } });
            const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new T3ApiError("T3 Code did not answer")); }, connectTimeoutMs);
            ws.addEventListener("open", () => {
              clearTimeout(timer);
              socket = ws;
              ws.addEventListener("message", (event) => { if (socket === ws) onMessage(event); });
              ws.addEventListener("close", () => {
                if (socket !== ws) return;
                socket = null;
                clearTimeout(idleTimer);
                settleAll(new T3ApiError("The connection to T3 Code closed"));
              });
              resolve(ws);
            }, { once: true });
            ws.addEventListener("error", () => {
              clearTimeout(timer);
              reject(new T3ApiError("T3 Code refused the console's connection"));
            }, { once: true });
          });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })().finally(() => { opening = null; });
    return opening;
  };

  /** One request, answered once. */
  const call = async (tag, payload = {}, { timeoutMs = callTimeoutMs } = {}) => {
    await connect();
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new T3ApiError(`T3 Code did not answer ${tag}`));
        scheduleIdle();
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      clearTimeout(idleTimer);
      send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  };

  /**
   * A stream of values until T3 ends it or `close()`: `onValue` per value,
   * `onEnd(error | null)` once. Resolves when the request has been sent.
   */
  const subscribe = async (tag, payload, onValue, onEnd = () => {}) => {
    await connect();
    const id = String(++nextId);
    let ended = false;
    const end = (error) => {
      if (ended) return;
      ended = true;
      onEnd(error);
    };
    pending.set(id, { onValue, onEnd: end });
    clearTimeout(idleTimer);
    send({ _tag: "Request", id, tag, payload, headers: [] });
    return {
      close() {
        if (!pending.delete(id)) return;
        try { send({ _tag: "Interrupt", requestId: id, interruptors: [] }); } catch { /* the socket is gone */ }
        end(null);
        scheduleIdle();
      },
    };
  };

  /** The first value of a stream, then stop: "what is the state right now". */
  const first = async (tag, payload, { timeoutMs = callTimeoutMs } = {}) => new Promise((resolve, reject) => {
    let sub = null;
    let done = false;
    const timer = setTimeout(() => finish(null, new T3ApiError(`T3 Code did not answer ${tag}`)), timeoutMs);
    const finish = (value, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub?.close();
      if (error) reject(error);
      else resolve(value);
    };
    subscribe(tag, payload, (value) => finish(value), (error) => finish(null, error ?? new T3ApiError(`${tag} ended without a value`)))
      .then((handle) => { sub = handle; if (done) handle.close(); }, (error) => finish(null, error));
  });

  const close = () => {
    clearTimeout(idleTimer);
    if (socket) {
      try { socket.close(); } catch { /* already closing */ }
    }
    socket = null;
    settleAll(new T3ApiError("The console closed its connection to T3 Code"));
  };

  /** Native HTTP endpoints, independent of an active RPC session. */
  const http = async (path, body) => {
    const generation = sessionGeneration;
    const target = new URL(url);
    target.protocol = target.protocol === "wss:" ? "https:" : "http:";
    target.pathname = path;
    target.search = "";
    target.hash = "";
    let refused = null;
    for (const fresh of [false, true]) {
      const credential = await ensureSession(credentials.http, fresh, refused);
      assertGeneration(generation);
      const { token } = credential;
      const response = await fetchImpl(target.toString(), {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(callTimeoutMs),
        redirect: "error",
      });
      if (generation !== sessionGeneration) {
        await response.body?.cancel();
        assertGeneration(generation);
      }
      if (response.status === 401 && !fresh) {
        await response.body?.cancel();
        refused = credential;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new T3ApiError(`T3 Code could not ${body === undefined ? "read" : "save"} connection settings (HTTP ${response.status}).`);
      }
      const data = await response.json();
      assertGeneration(generation);
      return data;
    }
  };

  const reset = () => {
    sessionGeneration += 1;
    protocolVersion = null;
    protocolDiscovery = null;
    close();
    for (const cache of Object.values(credentials)) {
      retireSession(cache.value);
      cache.value = null;
      cache.pending = null;
    }
  };
  return { call, http, subscribe, first, close, reset, sessionId: () => credentials.rpc.value?.sessionId ?? null };
}

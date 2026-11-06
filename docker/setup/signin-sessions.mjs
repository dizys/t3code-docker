// Sign-in sessions live only while the browser sheet needs them. A terminal
// verdict (done, failed, cancelled) stays readable briefly, then the entry is
// deleted so finished sign-ins cannot pile up child handles and output
// buffers. Clients polling after that get the same unknown-session answer as
// for a bad id.
export const TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);

// How long a terminal verdict stays readable before the entry is freed.
export const SESSION_KEEP_MS = 60 * 1000;

export function createSessionStore({ keepMs = SESSION_KEEP_MS } = {}) {
  const sessions = new Map();
  const schedule = (session) => {
    if (session.forgetTimer) return;
    session.forgetTimer = setTimeout(() => {
      if (sessions.get(session.id) === session && TERMINAL_STATES.has(session.state)) {
        try { session.child?.kill(); } catch {}
        if (session.watch) clearInterval(session.watch);
        try { session.flow?.close?.(); } catch {}
        sessions.delete(session.id);
      }
    }, keepMs);
    session.forgetTimer.unref?.();
  };
  // Set a terminal state (first verdict wins) and schedule the entry's
  // removal. With no state it only schedules, for call sites that already set
  // the fields. Returns null for an unknown id.
  const settle = (id, state = null, error) => {
    const session = typeof id === "object" && id !== null ? id : sessions.get(id);
    if (!session) return null;
    if (state && !TERMINAL_STATES.has(session.state)) {
      session.state = state;
      if (error !== undefined) session.error = error;
    }
    if (TERMINAL_STATES.has(session.state)) schedule(session);
    return session;
  };
  return {
    sessions,
    add: (session) => { sessions.set(session.id, session); return session; },
    get: (id) => sessions.get(id),
    settle,
    size: () => sessions.size,
  };
}

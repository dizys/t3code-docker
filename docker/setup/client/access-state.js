// Display-only reconciliation for Access mutations. The server remains the
// authority: a confirmed response bridges old/incomplete polls until the next
// fresh list read. Never use these rows to authorize an operation.
const T3AccessState = (() => {
  'use strict';
  const fields = { session: ['sessions', 'sessionId'], pairing: ['pairings', 'id'] };
  const key = (kind, id) => kind + ':' + id;
  const create = () => {
    let revision = 0;
    const pending = new Map(), effects = new Map(), errors = new Map();
    const begin = (kind, id, verb) => {
      const k = key(kind, id);
      if (pending.has(k)) return null;
      const operation = { kind, id, verb };
      pending.set(k, operation); errors.delete(k);
      return operation;
    };
    const finish = (operation, { error, session, removed } = {}) => {
      if (!operation || pending.get(key(operation.kind, operation.id)) !== operation) return;
      const k = key(operation.kind, operation.id);
      pending.delete(k);
      if (error) errors.set(k, error);
      else if (removed || session) effects.set(k, { ...operation, revision: ++revision, value: session || null });
    };
    const reconcile = (incoming, previous, readRevision = -1) => {
      const next = { ...incoming };
      for (const [kind, [field, idField]] of Object.entries(fields)) {
        const meta = incoming.authLists?.[kind];
        // Cache invalidation temporarily makes the server list unavailable.
        // Keep its last displayed rows while that independent read finishes.
        let rows = meta?.available === false ? previous?.[field] || [] : incoming[field] || [];
        const fresh = !meta || (meta.available && !meta.stale);
        for (const [k, effect] of effects) {
          if (effect.kind !== kind) continue;
          if (fresh && readRevision >= effect.revision) { effects.delete(k); continue; }
          if (effect.value) {
            const found = rows.some((row) => row[idField] === effect.id);
            rows = found ? rows.map((row) => row[idField] === effect.id ? effect.value : row) : [...rows, effect.value];
          } else rows = rows.filter((row) => row[idField] !== effect.id);
        }
        next[field] = rows;
      }
      return next;
    };
    return { begin, finish, reconcile,
      get revision() { return revision; },
      get busy() { return pending.size > 0 || effects.size > 0; },
      pending: (kind, id) => pending.get(key(kind, id)),
      error: (kind, id) => errors.get(key(kind, id)),
    };
  };
  return { create };
})();

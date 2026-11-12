// Every supplied setup-key guess, including cookies and headers, takes a slot
// before the secret is compared. Failures keep their slots through a per-IP
// serialized delay. Successful authentication releases immediately.
export function createKeyThrottle({ matches, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), perAddress = 4, pendingLimit = 256, failureLimit = 1000 } = {}) {
  const active = new Map(), tails = new Map(), failures = new Map();
  let pending = 0;
  return {
    async check(ip, candidate) {
      const count = active.get(ip) ?? 0;
      if (count >= perAddress || pending >= pendingLimit) throw Object.assign(new Error('Too many login attempts. Wait a moment and try again.'), { code: 'login-limit' });
      active.set(ip, count + 1); pending++;
      try {
        if (matches(candidate)) { failures.delete(ip); return true; }
        const run = (tails.get(ip) ?? Promise.resolve()).then(() => {
          const n = Math.min((failures.get(ip) ?? 0) + 1, 12);
          failures.delete(ip); failures.set(ip, n);
          if (failures.size > failureLimit) failures.delete(failures.keys().next().value);
          return wait(n * 250);
        });
        const tail = run.catch(() => {});
        tails.set(ip, tail);
        try { await run; }
        finally { if (tails.get(ip) === tail) tails.delete(ip); }
        return false;
      } finally {
        pending--;
        const left = active.get(ip) - 1;
        if (left) active.set(ip, left); else active.delete(ip);
      }
    },
  };
}

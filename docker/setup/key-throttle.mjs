// Every supplied setup-key guess, including cookies and headers, takes a slot
// before the secret is compared. Failures keep their slots through a per-IP
// serialized delay. Successful authentication releases immediately.
//
// After enough failures from one address it is locked out: further guesses
// are refused at once, for a growing window, without taking a slot or
// queuing another delayed check. A locked-out flood therefore holds no room
// in the shared pending cap, so other visitors keep getting answers.
export function createKeyThrottle({ matches, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), perAddress = 4, pendingLimit = 256, failureLimit = 1000, lockoutAfter = 20, lockoutBaseMs = 30_000, lockoutMaxMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const active = new Map(), tails = new Map(), failures = new Map(), lockedUntil = new Map();
  let pending = 0;
  const lockoutFor = (strikes) => Math.min(lockoutBaseMs * 2 ** Math.floor((strikes - lockoutAfter) / 5), lockoutMaxMs);
  return {
    clearFailures() { failures.clear(); lockedUntil.clear(); },
    async check(ip, candidate) {
      // Locked out: refuse at once, before taking any shared slot, so a
      // guessing flood stops crowding out everyone else's attempts.
      const until = lockedUntil.get(ip);
      if (until !== undefined) {
        if (now() < until) throw Object.assign(new Error('Too many login attempts. Wait a moment and try again.'), { code: 'login-limit' });
        lockedUntil.delete(ip);
      }
      const count = active.get(ip) ?? 0;
      if (count >= perAddress || pending >= pendingLimit) throw Object.assign(new Error('Too many login attempts. Wait a moment and try again.'), { code: 'login-limit' });
      active.set(ip, count + 1); pending++;
      try {
        if (matches(candidate)) { failures.delete(ip); lockedUntil.delete(ip); return true; }
        const run = (tails.get(ip) ?? Promise.resolve()).then(() => {
          const strikes = (failures.get(ip) ?? 0) + 1;
          failures.delete(ip); failures.set(ip, strikes);
          if (failures.size > failureLimit) failures.delete(failures.keys().next().value);
          if (strikes >= lockoutAfter) {
            lockedUntil.delete(ip); lockedUntil.set(ip, now() + lockoutFor(strikes));
            if (lockedUntil.size > failureLimit) lockedUntil.delete(lockedUntil.keys().next().value);
          }
          return wait(Math.min(strikes, 12) * 250);
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

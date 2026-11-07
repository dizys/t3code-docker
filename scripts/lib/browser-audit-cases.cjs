// Run complete browser scenarios with a bounded queue. Each case owns its
// contexts and fixture servers; a failure never prevents the remaining cases.
const fs = require('node:fs/promises');
const path = require('node:path');

async function runCases(cases, work, { name = 'Browser audit', output, workers = process.env.T3_UI_AUDIT_WORKERS ?? '1', log = console.log } = {}) {
  workers = Number(workers);
  if (![1, 2].includes(workers)) throw new Error('T3_UI_AUDIT_WORKERS must be 1 or 2');
  if (!cases.length) throw new Error(name + ': no scenarios selected');
  const results = new Array(cases.length), failures = [];
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const index = next++, value = cases[index], started = performance.now();
      const label = `${name} ${index + 1}/${cases.length} ${JSON.stringify(value)}`;
      const cleanups = [], contexts = [], errors = [];
      const scope = {
        cleanup: fn => cleanups.push(fn),
        context: async (browser, options) => {
          const context = await browser.newContext(options);
          contexts.push(context);
          cleanups.push(() => context.close());
          return context;
        },
        page: async (browser, options) => (await scope.context(browser, options)).newPage(),
      };
      log('START ' + label);
      try {
        await work(value, scope);
      } catch (error) {
        errors.push(error);
        // Capture before cleanup, with a distinct name for every failed case.
        if (output) {
          try {
            await fs.mkdir(output, { recursive: true });
            let pageIndex = 0;
            for (const context of contexts) for (const page of context.pages()) {
              await page.screenshot({ path: path.join(output, `failure-case-${index + 1}-page-${++pageIndex}.png`), timeout: 5000 }).catch(() => {});
            }
          } catch { /* Diagnostics must not stop the queue or mask the assertion. */ }
        }
      } finally {
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
      }
      results[index] = { ok: !errors.length, milliseconds: performance.now() - started };
      log(`${errors.length ? 'FAIL' : 'PASS'} ${label} (${(results[index].milliseconds / 1000).toFixed(1)}s)`);
      if (errors.length) failures.push(new AggregateError(errors, label));
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, cases.length) }, worker));
  if (failures.length) throw new AggregateError(failures, `${name}: ${failures.length}/${cases.length} scenarios failed; all scenarios finished`);
  return results;
}

module.exports = { runCases };

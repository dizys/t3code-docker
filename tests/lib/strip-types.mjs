// Type stripping for tests that execute production TypeScript sources.
// New Node ships `node:module`'s `stripTypeScriptTypes`; Bun transpiles
// natively instead, so fall back to its transpiler there. Anything else
// fails loudly at call time, as the bare import does today.
import Module from 'node:module';

const bunStrip = typeof Bun === 'undefined' ? null
  : (code) => new Bun.Transpiler({ loader: 'ts' }).transformSync(code);

const missing = () => { throw new Error('Type stripping needs Node 22.13+ or Bun.'); };

export const stripTypeScriptTypes = Module.stripTypeScriptTypes ?? bunStrip ?? missing;

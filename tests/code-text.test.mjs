import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../docker/setup/client/code-text.js', import.meta.url), 'utf8') + '\nglobalThis.T = T3CodeText;', context);
const T = context.T;

test('Markdown distinguishes frontmatter, prose and fenced code without executing markup', () => {
  const source = '---\nname: example\n---\n# Heading\nUse `tool` and **care**.\n```js\nconst x = "<img onerror=alert(1)>";\n```\nAfter';
  const doc = T.documentOf(source, 'markdown');
  assert.deepEqual(Array.from(doc.modes), ['delimiter','frontmatter','delimiter','markdown','markdown','delimiter','code','delimiter','markdown']);
  assert.equal(T.tokens(doc.lines[3], doc.modes[3])[0].tone, 'h');
  assert(T.tokens(doc.lines[4], 'markdown').some(t => t.tone === 's'));
  assert(T.tokens(doc.lines[6], 'code').some(t => t.tone === 'k'));
  for (let i = 0; i < doc.lines.length; i++) assert.equal(T.tokens(doc.lines[i], doc.modes[i]).map(t => t.text).join(''), doc.lines[i]);
});

test('syntax and viewport work stay bounded independently of document length', () => {
  const tokens = T.tokens('const x = "value"; '.repeat(10000));
  assert(tokens.length < 260); assert(tokens.map(t => t.text).join('').length <= 4000);
  for (const top of [0, 22000, 2200000]) {
    const {first,last} = T.viewport(1000000, top, 600, 22);
    assert(first >= 0); assert(last <= 1000000); assert(last - first <= 53);
  }
  assert.equal(T.language('AGENTS.md'), 'markdown'); assert.equal(T.language('/x/file.ts'), 'code');
});

test('caret offsets follow native UTF-16 selections, including blank and final lines', () => {
  const doc = T.documentOf('a\n日本語🙂\n\n');
  for (const [offset,line,column] of [[0,0,1],[2,1,1],[7,1,6],[8,2,1],[9,3,1]]) assert.deepEqual({...T.position(doc.starts,offset)},{line,column});
});


test('Find is literal and keeps native offsets after Unicode case folding', () => {
  assert.deepEqual(Array.from(T.matches('İ x 日本語🙂 CONST [x] const','const')), [10,20]);
  assert.deepEqual(Array.from(T.matches('a.* [x] a.*','a.*')), [0,8]);
  assert.deepEqual(Array.from(T.matches('empty','')), []);
  assert.equal(T.matches('x'.repeat(20000),'x').length,10000);
});

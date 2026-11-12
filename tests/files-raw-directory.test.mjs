import assert from 'node:assert/strict';
import test from 'node:test';
import {opendirRaw} from '../docker/setup/files/io.mjs';

test('raw directory iteration preserves filename bytes from Node and Bun', async () => {
  for (const dirents of [true, false]) {
    const names = [Buffer.from('valid'), Buffer.from([0xff, 0xfe])];
    const directory = await opendirRaw('/fixture', {opendir: async () => ({
      close: async () => {},
      async *[Symbol.asyncIterator]() {for (const name of names) yield dirents ? {name} : name;},
    })});
    const actual = []; for await (const entry of directory) actual.push(entry.name);
    assert.deepEqual(actual, names);
    assert.throws(() => new TextDecoder('utf-8', {fatal: true}).decode(actual[1]), 'invalid UTF-8 remains detectable by callers');
  }
});

test('directory consumers can stop without reading the remaining entries', async () => {
  let read = 0, released = false;
  const directory = await opendirRaw('/fixture', {opendir: async () => ({
    close: async () => {},
    async *[Symbol.asyncIterator]() {
      try {for (let i = 0; i < 100000; i++) {read++; yield Buffer.from(String(i));}}
      finally {released = true;}
    },
  })});
  for await (const entry of directory) {assert.equal(entry.name.toString(), '0'); break;}
  assert.equal(read, 1, 'entry limits do not first materialize the entire directory');
  assert.equal(released, true);
});

test('unsupported raw directory iteration never falls back to an unbounded readdir', async () => {
  let readdirCalls = 0;
  await assert.rejects(opendirRaw('/fixture', {
    opendir: async () => {throw Object.assign(new Error('Buffer encoding unsupported'), {code: 'ERR_INVALID_ARG_TYPE'});},
    readdir: async () => {readdirCalls++; return [Buffer.from('one')];},
  }), {code: 'ERR_INVALID_ARG_TYPE'});
  assert.equal(readdirCalls, 0);
});

test('already-decoded directory names cannot conceal invalid filename bytes', async () => {
  const directory = await opendirRaw('/fixture', {opendir: async () => ({
    close: async () => {},
    async *[Symbol.asyncIterator]() {yield {name: 'replacement\ufffd'};},
  })});
  await assert.rejects(async () => {for await (const entry of directory) void entry;}, /raw filename bytes/);
});

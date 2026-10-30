import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { renderConsole, renderUnlock } from '../docker/setup/page.mjs';

const options = { assets: { css: '/* fixture */', console: [], unlock: [] }, nonce: 'fixture', mount: '/__setup' };
const shell = html => html.replace(/<script[\s\S]*?<\/script>/g, '');
test('standalone shell and unlock markup remain byte identical', async () => {
  assert.equal(shell(renderConsole(options)), await readFile(new URL('fixtures/standalone-shell.html', import.meta.url), 'utf8'));
  assert.equal(shell(renderUnlock({ ...options, host: 'fixture.example', publicUrl: 'https://fixture.example' })), await readFile(new URL('fixtures/standalone-unlock.html', import.meta.url), 'utf8'));
});
test('only the tab embed variant replaces the console shell', () => {
  const html = shell(renderConsole({ ...options, embed: true, host: 'tab', layout: 'wide' }));
  assert.match(html, /data-host="tab" data-host-layout="wide"/);
  assert.doesNotMatch(html, /tc-sidebar|tc-phonebar|tc-tabbar|page-more/);
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.match(html, /id="setup-pages"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.equal((html.match(/data-cmd="embed.close"/g) || []).length, 2);
  for (const opts of [{host:'tab'}, {embed:true}, {embed:true,host:'invalid'}]) {
    const html = shell(renderConsole({ ...options, ...opts }));
    assert.doesNotMatch(html, /data-host=|tc-pagebar/);
    assert.match(html, /tc-sidebar/);
  }
});
test('unlock preserves the host enums without interpolating caller input', () => {
  const html = shell(renderUnlock({ ...options, embed:true, host:'tab', layout:'wide', hostname:'<example>' }));
  assert.match(html, /name="host" value="tab"/);
  assert.match(html, /name="layout" value="wide"/);
  assert.match(html, /&lt;example&gt;/);
  assert.doesNotMatch(html, /tc-masthead[^\n]+embed.close/);
  const unknown = shell(renderConsole({ ...options, embed:true, host:'tab', layout:'" onload="bad' }));
  assert.match(unknown, /data-host-layout="compact"/);
  assert.doesNotMatch(unknown, /onload/);
});
test('boot density follows the frame, independently of host layout', () => {
  for (const tab of [false, true]) for (const width of [390, 639, 640, 704, 1023, 1024]) {
    const attrs = new Map(tab ? [['data-embed','t3'],['data-host','tab']] : []);
    const root = { dataset: {host: tab ? 'tab' : undefined}, hasAttribute: k=>attrs.has(k), setAttribute: (k,v)=>attrs.set(k,v), toggleAttribute: (k,on)=>on?attrs.set(k,''):attrs.delete(k) };
    const body = { setAttribute: (k,v)=>attrs.set('body:'+k,v) };
    const context = vm.createContext({document:{documentElement:root,body},localStorage:{getItem:()=>null},location:{search:tab?'?embed=t3&host=tab&layout=wide':''},URLSearchParams,matchMedia:q=>({matches:q.includes('dark')?false:width<=Number(q.match(/max-width: ([\d.]+)/)?.[1]||0)})});
    const html = renderConsole({ ...options, embed:tab, host:tab?'tab':undefined, layout:'wide' });
    for (const [,code] of html.matchAll(/<script nonce="fixture">([\s\S]*?)<\/script>/g)) if (!code.includes('window.__')) vm.runInContext(code,context);
    assert.equal(attrs.has('data-compact'), width < (tab?640:1024), `${tab}:${width}`);
    assert.equal(attrs.has('body:data-density'), attrs.has('data-compact'));
  }
});

test('every shell icon is present in the source icon library', async () => {
  const context=vm.createContext({window:{},document:{readyState:'loading',addEventListener(){}},navigator:{}});
  vm.runInContext(await readFile(new URL('../docker/setup/design/ui.js',import.meta.url),'utf8'),context);
  for(const embed of [false,true]) for(const host of [undefined,'tab']) for(const render of [renderConsole,renderUnlock]) {
    const html=render({...options,embed,host,layout:'compact'});
    for(const [,name]of html.matchAll(/<i data-icon="([^"]+)"/g))assert.ok(context.window.T3C.icons[name],`Missing shell icon: ${name}`);
  }
});

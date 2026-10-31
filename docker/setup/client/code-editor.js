// Native text input, selection, undo and IME; a bounded mirror paints syntax.
// Each caller owns saving and conflicts. The editor owns only its local view.
const T3CodeEditor = (() => {
  'use strict';
  const { html, raw, icon } = Kit, T = T3CodeText;
  const mirror = ({ lines, modes = [], scroll = 0, left = 0, line = -1, height = innerHeight, lineHeight = 22, charWidth = 7.8, transform = value => value }) => {
    const { first, last } = T.viewport(lines.length, scroll, height, lineHeight);
    return html`<pre class="tc-files-editor-mirror" data-editor-mirror aria-hidden="true"><div style="height:${first * lineHeight}px"></div>${lines.slice(first, last).map((value, index) => {
      const number = first + index, text = transform(value, number), start = text.length > 4000 ? Math.max(0, Math.floor(left / charWidth) - 80) : 0;
      return html`<span class="tc-files-editor-line"${number === line ? raw(' data-cur') : ''}><i>${number + 1}</i><code>${start ? html`<span style="display:inline-block;width:${start}ch"></span>` : ''}${T.tokens(text.slice(start, start + 4000) || ' ', modes[number]).map(token => token.tone ? html`<span class="${token.tone}">${token.text}</span>` : token.text)}${text.length > start + 4000 ? html`<span style="display:inline-block;width:${text.length - start - 4000}ch"></span>` : ''}</code></span>`;
    })}<div style="height:${Math.max(0, lines.length - last) * lineHeight}px"></div></pre>`;
  };
  const create = ({ id, label, mode = 'markdown', describedBy, placeholder = '' }) => {
    let root, field, canvas, status, doc = T.documentOf('', mode), value = null, frame = null, resize, find = '', match = -1, options = {}, listeners = [];
    const markup = () => html`<div class="tc-source-editor" data-source-editor="${id}" data-key="editor:${id}" data-keep>
      <div class="tc-source-tools"><span>${mode === 'markdown' ? 'Markdown' : 'Text'} <span data-source-count></span></span><button type="button" class="tc-btn tc-btn--ghost tc-btn--xs" data-source-find>${icon('search')}Find</button></div>
      <div class="tc-source-find" hidden><label class="tc-sr" for="${id}-find">Find in ${label}</label><input class="tc-input" id="${id}-find" placeholder="Find in text" autocomplete="off"><span data-source-matches role="status"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-source-prev aria-label="Previous match">${icon('chevron-up')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-source-next aria-label="Next match">${icon('chevron-down')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-source-find-close aria-label="Close find">${icon('x')}</button></div>
      <div class="tc-files-editor-workspace"><div data-source-canvas></div><textarea class="tc-files-editor-input" id="${id}" data-key="${id}" aria-label="${label}"${describedBy ? html` aria-describedby="${describedBy}"` : ''} placeholder="${placeholder}" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea></div>
      <div class="tc-source-status" data-source-status aria-live="off"></div></div>`;
    const paint = () => {
      frame = null; if (!root?.isConnected) return;
      const pos = T.position(doc.starts, field.selectionStart), style = getComputedStyle(field), lineHeight = parseFloat(style.lineHeight);
      Kit.patch(canvas, mirror({ ...doc, scroll: field.scrollTop, left: field.scrollLeft, line: options.readOnly ? -1 : pos.line, height: field.clientHeight, lineHeight, charWidth: parseFloat(style.fontSize) * .6 }));
      const pre = canvas.querySelector('pre'); if (pre) { pre.scrollTop = field.scrollTop; pre.scrollLeft = field.scrollLeft; }
      status.textContent = (options.readOnly ? 'Read-only · ' : '') + 'Line ' + (pos.line + 1) + ', column ' + pos.column;
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const read = () => { if (value !== field.value) { value = field.value; doc = T.documentOf(value, mode); root.style.setProperty('--code-gutter', 'max(3rem, calc(' + String(doc.lines.length).length + 'ch + 1.125rem))'); root.querySelector('[data-source-count]').textContent = '· ' + doc.lines.length + (doc.lines.length === 1 ? ' line' : ' lines'); } later(); };
    const select = delta => {
      const found = T.matches(value, find); match = found.length ? (match + delta + found.length) % found.length : -1;
      root.querySelector('[data-source-matches]').textContent = !find ? '' : found.length ? (match + 1) + ' of ' + found.length + (found.length === 10000 ? '+' : '') : 'No matches';
      if (match >= 0) { field.focus(); field.setSelectionRange(found[match], found[match] + find.length); field.scrollTop = Math.max(0, T.position(doc.starts, found[match]).line * parseFloat(getComputedStyle(field).lineHeight) - field.clientHeight / 3); } later();
    };
    const findOpen = open => { root.querySelector('.tc-source-find').hidden = !open; if (open) root.querySelector('.tc-source-find input').focus(); else field.focus(); later(); };
    const destroy = () => { cancelAnimationFrame(frame); frame = null; resize?.disconnect(); for (const remove of listeners) remove(); listeners = []; root = field = canvas = status = null; value = null; };
    const sync = (panel, next) => {
      options = next;
      const target = panel.querySelector('[data-source-editor="' + id + '"]'); if (!target) { if (root) destroy(); return; }
      if (target !== root) {
        destroy(); root = target; field = root.querySelector('textarea'); canvas = root.querySelector('[data-source-canvas]'); status = root.querySelector('[data-source-status]');
        const on = (element, name, handler) => { element.addEventListener(name, handler); listeners.push(() => element.removeEventListener(name, handler)); };
        on(field, 'input', read); for (const name of ['scroll', 'select', 'keyup', 'pointerup', 'focus', 'blur']) on(field, name, later);
        on(root, 'keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); findOpen(true); } else if (event.key === 'Escape' && !root.querySelector('.tc-source-find').hidden) { event.preventDefault(); event.stopPropagation(); findOpen(false); } else if (event.target.id === id + '-find' && event.key === 'Enter') { event.preventDefault(); select(event.shiftKey ? -1 : 1); } });
        on(root.querySelector('.tc-source-find input'), 'input', event => { find = event.target.value; match = -1; select(1); root.querySelector('.tc-source-find input').focus(); });
        on(root, 'click', event => { const button = event.target.closest('button'); if (!button) return; if (button.hasAttribute('data-source-find')) findOpen(root.querySelector('.tc-source-find').hidden); if (button.hasAttribute('data-source-find-close')) findOpen(false); if (button.hasAttribute('data-source-next')) select(1); if (button.hasAttribute('data-source-prev')) select(-1); });
        resize = new ResizeObserver(later); resize.observe(field);
      }
      field.disabled = !!next.disabled; field.readOnly = !!next.readOnly;
      if (field.value !== next.value) { const start = field.selectionStart, end = field.selectionEnd; field.value = next.value; field.setSelectionRange(Math.min(start, next.value.length), Math.min(end, next.value.length)); }
      read();
    };
    return { markup, sync, destroy, escape: () => { if (!root || root.querySelector('.tc-source-find').hidden) return false; findOpen(false); return true; } };
  };
  return { mirror, create };
})();

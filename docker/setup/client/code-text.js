// Escaped lexical accents and bounded viewports shared by every source editor.
// This is a classic, DOM-free module so the same limits are tested in Node.
const T3CodeText = (() => {
  'use strict';
  const language = name => /\.(md|mdown|markdown)$/i.test(name || '') ? 'markdown' : 'code';
  const documentOf = (text, mode = 'code') => {
    const lines = text.split('\n'), modes = [], starts = []; let at = 0, fence = null, front = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; starts.push(at); at += line.length + 1;
      if (mode !== 'markdown') { modes.push('code'); continue; }
      if (i === 0 && line.trim() === '---') { front = true; modes.push('delimiter'); continue; }
      if (front) { modes.push(line.trim() === '---' ? 'delimiter' : 'frontmatter'); if (line.trim() === '---') front = false; continue; }
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (marker && (!fence || marker[1][0] === fence[0] && marker[1].length >= fence.length)) { modes.push('delimiter'); fence = fence ? null : marker[1]; }
      else modes.push(fence ? 'code' : 'markdown');
    }
    return { lines, modes, starts };
  };
  const tokens = (line, mode = 'code') => {
    const text = line.slice(0, 4000), out = [];
    if (mode === 'delimiter') return [{ text, tone: 'm' }];
    if (mode === 'markdown' && /^ {0,3}#{1,6}\s/.test(text)) return [{ text, tone: 'h' }];
    const expression = mode === 'markdown'
      ? /(`+[^`\n]*`+|\*\*[^*\n]+\*\*|__[^_\n]+__|!?\[[^\]\n]*\]\([^\)\n]*\)|^\s*(?:>|[-*+]\s|\d+\.\s))/g
      : /(\/\/.*$|^\s*#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|import|from|export|default|function|return|async|await|class|new|if|else|true|false|null|def|fn|pub|use|struct|type|interface)\b|^[\w-]+(?=:))/g;
    let at = 0, match;
    while (out.length < 256 && (match = expression.exec(text))) {
      if (match.index > at) out.push({ text: text.slice(at, match.index) });
      const word = match[0], tone = mode === 'markdown' ? /^(?:\*\*|__)/.test(word) ? 'b' : /^\s*(?:>|[-*+]|\d+\.)/.test(word) ? 'k' : 's' : /^(?:\s*#|\/\/)/.test(word) ? 'm' : /^["'`]/.test(word) ? 's' : 'k';
      out.push({ text: word, tone }); at = expression.lastIndex;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  };
  const position = (starts, offset) => { let lo = 0, hi = starts.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= offset) lo = mid + 1; else hi = mid; } const line = Math.max(0, lo - 1); return { line, column: offset - starts[line] + 1 }; };
  const matches = (text, needle) => {
    if (!needle) return [];
    const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), found = []; let match;
    while (found.length < 10000 && (match = expression.exec(text))) found.push(match.index);
    return found;
  };
  const viewport = (count, top, height, lineHeight) => { const first = Math.max(0, Math.floor(top / lineHeight) - 12), last = Math.min(count, first + Math.ceil(height / lineHeight) + 25); return { first, last }; };
  return { language, documentOf, tokens, position, viewport, matches };
})();

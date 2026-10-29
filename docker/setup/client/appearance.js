// Native T3 appearance messages carry semantic colors, never arbitrary CSS.
// Keep local component names here so the bridge does not depend on Kit internals.
const T3Appearance = (() => {
  'use strict';
  const COLORS = Object.freeze({
    '--bg': 'background', '--surface': 'card', '--surface-raised': 'popover',
    '--surface-sunken': 'muted', '--fg': 'foreground', '--fg-muted': 'muted-foreground',
    '--fg-subtle': 'placeholder', '--border': 'border', '--border-strong': 'input',
    '--accent': 'primary', '--on-accent': 'primary-foreground', '--accent-text': 'update-foreground',
    '--focus': 'ring', '--hover': 'accent', '--pressed': 'accent',
    '--sidebar': 'sidebar', '--sidebar-fg': 'sidebar-foreground',
    '--sidebar-fg-muted': 'sidebar-muted-foreground', '--sidebar-border': 'sidebar-border',
    '--sidebar-row-hover': 'sidebar-row-hover', '--sidebar-row-active': 'sidebar-row-active',
    '--sidebar-row-selected': 'sidebar-row-selected', '--sidebar-control': 'sidebar-control-surface',
    '--warn': 'warning', '--warn-text': 'warning-foreground', '--warn-soft': 'warning-surface',
    '--danger': 'destructive', '--danger-text': 'destructive-foreground', '--danger-soft': 'error-surface',
    '--ok': 'success', '--ok-text': 'success-foreground', '--info': 'info', '--info-text': 'info-foreground',
  });
  const FONTS = Object.freeze({ '--font-sans': 'sans', '--font-mono': 'mono' });
  const OWNED = [...Object.keys(COLORS), ...Object.keys(FONTS), '--control-radius', '--font-smoothing'];
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const literal = (value, property, supports) => typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[;{}<>]/.test(value) && !/\b(?:url|var|env)\s*\(/i.test(value) && supports(property, value);

  const normalize = (value, supports) => {
    if (!record(value) || value.version !== 1 || !record(value.colors) || typeof supports !== 'function') return null;
    const properties = {};
    for (const [token, role] of Object.entries(COLORS)) {
      const color = Object.hasOwn(value.colors, role) ? value.colors[role] : null;
      if (literal(color, 'color', supports)) properties[token] = color;
    }
    if (record(value.fonts)) for (const [token, role] of Object.entries(FONTS)) {
      const font = Object.hasOwn(value.fonts, role) ? value.fonts[role] : null;
      if (literal(font, 'font-family', supports)) properties[token] = font;
    }
    if (record(value.fonts) && ['auto', 'antialiased', 'subpixel-antialiased'].includes(value.fonts.smoothing)) properties['--font-smoothing'] = value.fonts.smoothing;
    if (typeof value.radius === 'string' && /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem))$/.test(value.radius)
      && value.radius.length <= 16 && parseFloat(value.radius) <= (value.radius.endsWith('rem') ? 2 : 32)
      && supports('border-radius', value.radius)) properties['--control-radius'] = value.radius;
    const size = typeof value.fontSize === 'string' && /^(?:\d+(?:\.\d+)?)px$/.test(value.fontSize) ? parseFloat(value.fontSize) : null;
    return { properties, fontSize: size !== null && size >= 12 && size <= 20 ? `${size}px` : null };
  };

  const clear = (root) => {
    for (const token of OWNED) root.style.removeProperty(token);
    root.style.removeProperty('font-size');
  };
  const apply = (root, value) => {
    const result = normalize(value, (property, text) => CSS.supports(property, text));
    if (!result) return false;
    // A palette can lose a role when switching to an older host. Remove its
    // previous override so the current light/dark default takes over cleanly.
    clear(root);
    for (const [token, color] of Object.entries(result.properties)) root.style.setProperty(token, color);
    if (result.fontSize) root.style.fontSize = result.fontSize;
    else root.style.removeProperty('font-size');
    return true;
  };
  return { COLORS, FONTS, normalize, apply, clear };
})();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regenerate the standalone design artifact, without touching product sources.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const design = path.join(root, 'docker/setup/design');
const tokens = fs.readFileSync(path.join(design, 'tokens.css'), 'utf8');
const components = fs.readFileSync(path.join(design, 'components.css'), 'utf8');
const font = fs.readFileSync(path.join(design, 'fonts/inter-latin-variable.woff2')).toString('base64');
const styles = fs.readFileSync(path.join(here, 'prototype.css'), 'utf8').replace('__INTER_FONT__', `data:font/woff2;base64,${font}`);
const icons = fs.readFileSync(path.join(here, 'icons.json'), 'utf8');
const script = fs.readFileSync(path.join(here, 'prototype.js'), 'utf8');
const customScript = fs.readFileSync(path.join(here, 'custom-prototype.js'), 'utf8');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Optional services · T3 Code design prototype</title>
<style>${tokens}\n${components}\n${styles}</style></head><body>
<div id="prototype" class="tc-root" data-palette="host">
<div class="demo-controls" aria-label="Prototype controls">
 <span class="demo-controls-label">${JSON.parse(icons).info}Prototype · simulated data</span>
 <div class="demo-control-fields">
  <label class="tc-sr" for="scenario">Scenario</label><select id="scenario" class="tc-select"><option value="custom">Custom service</option><option value="ready">Ready to connect</option><option value="fresh">First setup</option><option value="installing">Installing</option><option value="expired">Sign-in expired</option><option value="failed">Service failed</option><option value="storage">Storage required</option><option value="rollback">Update rolled back</option><option value="stale">Status unavailable</option></select>
  <label class="tc-sr" for="appearance">Appearance</label><select id="appearance" class="tc-select"><option value="host">Match appearance</option><option value="light">Light</option><option value="dark">Dark</option></select>
 </div>
</div>
<div id="app" class="tc-app demo-shell"></div>
<dialog id="sheet" class="demo-dialog" aria-labelledby="sheet-title" aria-describedby="sheet-description"></dialog>
<div id="announcement" class="tc-sr" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="toast" class="toast" role="status" hidden></div>
</div>
<script>const ICONS = ${icons};\n${customScript}\n${script}</script>
</body></html>`;
fs.writeFileSync(path.join(here, 'prototype.html'), html);
fs.writeFileSync(path.join(here, 'custom-services.html'), html.replace('<script>const ICONS', '<script>window.__PROTOTYPE_SCENARIO__="custom";const ICONS'));
console.log(`Wrote prototype.html (${Buffer.byteLength(html)} bytes)`);

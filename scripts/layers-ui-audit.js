#!/usr/bin/env node
// Real CSS/Web Animations checks for closing Setup overlays. No API or server.
// NODE_PATH=.../playwright/node_modules node scripts/layers-ui-audit.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const setup = process.env.T3_SETUP_DIR || path.join(__dirname, '../docker/setup');
const css = ['design/tokens.css', 'design/components.css', 'console.css'].map(file => fs.readFileSync(path.join(setup, file), 'utf8')).join('\n');
const kit = fs.readFileSync(path.join(setup, 'client/kit.js'), 'utf8');
const variants = [['desktop', 1280, false], ['phone', 390, false], ['settings-wide', 704, true], ['settings-compact', 480, true]];
const panels = [['center', 'tc-dialog'], ['sheet', 'tc-sheet tc-skill-inspector'], ['sheet', 'tc-sheet tc-sheet--editor tc-files-editor'], ['center', 'tc-fdlg'], ['bottom', 'tc-sheet tc-sheet--bottom'], ['palette', 'tc-palette']];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const watchdog = setTimeout(() => { console.error('Overlay motion audit timed out'); process.exitCode = 1; void browser.close(); }, 120000);
  let checks = 0;
  try {
    for (const theme of ['light', 'dark']) for (const [name, width, tab] of variants) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'no-preference' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent(`<html data-theme="${theme}"${tab ? ' data-host="tab"' : ''}><head><style>${css}</style></head><body class="tc-root"><main id="app" style="height:1800px"><button id="trigger">Open</button><button id="other">Other action</button></main><div id="layers"></div></body></html>`);
      await page.addScriptTag({ content: kit });
      for (const [kind, className] of panels) for (const progress of [0.25, 1]) {
        const result = await page.evaluate(async ({ kind, className, progress }) => {
          const trigger = document.getElementById('trigger'); trigger.focus();
          const notifications = [], off = Kit.onModalChange(open => notifications.push({ open, layers: document.querySelectorAll('.tc-layer').length }));
          let callbacks = 0;
          const layer = Kit.open({ kind, panel: { class: className, role: 'dialog', 'aria-modal': 'true' }, render: () => Kit.html`<div class="tc-dialog-body"><h2>Motion check</h2><button>Close</button></div>`, onClose: () => callbacks++ });
          // Pause opening at a known visible pose, so cold/slow frames exercise
          // the same quick-close case without depending on wall-clock timing.
          for (const child of layer.el.children) for (const animation of child.getAnimations()) {
            animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) * progress;
          }
          const pose = element => {
            const style = getComputedStyle(element);
            return { opacity: style.opacity, translate: style.translate, scale: style.scale, transform: style.transform };
          };
          const before = [...layer.el.children].map(pose);
          layer.close('cancel'); layer.close('escape');
          const immediate = { poses: [...layer.el.children].map(pose), inert: document.getElementById('app').inert, locked: document.documentElement.classList.contains('tc-locked'), focused: document.activeElement === trigger, callbacks, notifications: [...notifications] };
          const fades = [...layer.el.children].flatMap(child => child.getAnimations().filter(animation => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)));
          if (fades.length !== layer.el.children.length) { off(); return { before, immediate, missingFade: true }; }
          for (const fade of fades) fade.pause();
          const frames = [0, 20, 60, 100, 139].map(time => {
            for (const fade of fades) fade.currentTime = time;
            return { poses: [...layer.el.children].map(pose) };
          });
          for (const fade of fades) fade.finish(); await Promise.all(fades.map(fade => fade.finished));
          const after = { layers: document.querySelectorAll('.tc-layer').length, top: Kit.top(), inert: document.getElementById('app').inert, focused: document.activeElement === trigger, callbacks, notifications };
          off(); return { before, immediate, frames, after };
        }, { kind, className, progress });
        const label = `${name} ${theme} ${className} ${progress < 1 ? 'quick first close' : 'settled close'}`;
        assert.deepEqual(result.immediate.poses, result.before, label + ': no opening-pose reset');
        assert.equal(result.immediate.inert, true, label + ': page stays inert during exit');
        assert.equal(result.immediate.locked, true, label + ': scroll stays locked during exit');
        assert.equal(result.immediate.focused, false, label + ': focus stays out of the underlying page during exit');
        assert.deepEqual(result.immediate.notifications, [{ open: true, layers: 1 }], label + ': Settings stays dimmed');
        assert.equal(result.missingFade, undefined, label + ': panel and backdrop fade from their current appearance');
        for (let i = 0; i < result.frames.length; i++) {
          for (let child = 0; child < result.before.length; child++) {
            const { opacity, ...geometry } = result.frames[i].poses[child];
            const { opacity: initialOpacity, ...initialGeometry } = result.before[child];
            assert.deepEqual(geometry, initialGeometry, label + ': panel and backdrop never jump');
            assert(Number(opacity) <= Number(i ? result.frames[i - 1].poses[child].opacity : initialOpacity), label + ': no flash during fade');
          }
        }
        assert.deepEqual(result.after, { layers: 0, top: null, inert: false, focused: true, callbacks: 1, notifications: [{ open: true, layers: 1 }, { open: false, layers: 0 }] }, label + ': unlock and focus restoration happen once after removal');
        checks++;
      }
      const nested = await page.evaluate(async () => {
        const trigger = document.getElementById('trigger'); trigger.focus();
        const changes = [], off = Kit.onModalChange(open => changes.push(open));
        const open = () => Kit.open({ kind: 'center', panel: { class: 'tc-dialog' }, render: () => Kit.html`<button>Dialog action</button>` });
        const finish = async layer => { const fades = [...layer.el.children].flatMap(child => child.getAnimations().filter(animation => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition))); for (const fade of fades) fade.finish(); await Promise.all(fades.map(fade => fade.finished)); };
        const parent = open(), parentButton = parent.panel.querySelector('button'), child = open();
        for (const layer of [parent, child]) for (const element of layer.el.children) for (const animation of element.getAnimations()) {
          animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration);
        }
        let parentClicks = 0, escaped = 0;
        parentButton.addEventListener('click', () => parentClicks++);
        const hostEscape = event => { if (event.key === 'Escape') escaped++; };
        document.addEventListener('keydown', hostEscape);
        child.close();
        const rect = parentButton.getBoundingClientRect();
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2).click();
        child.panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        document.removeEventListener('keydown', hostEscape);
        await finish(child);
        const nestedFocus = document.activeElement === parentButton;
        parent.close();
        // A new dialog opened by an immediate close callback must retain focus
        // and eventually return to the original page trigger.
        const successor = open(), successorButton = successor.panel.querySelector('button');
        await finish(parent);
        const successorFocus = document.activeElement === successorButton;
        successor.close(); await finish(successor);
        off();
        return { parentClicks, escaped, nestedFocus, successorFocus, finalFocus: document.activeElement === trigger, changes, layers: document.querySelectorAll('.tc-layer').length };
      });
      assert.deepEqual(nested, { parentClicks: 0, escaped: 0, nestedFocus: true, successorFocus: true, finalFocus: true, changes: [true, false], layers: 0 }, name + ': nested and replacement dialogs never leak clicks/Escape, undim/re-dim the host or steal focus'); checks++;
      const closeAll = await page.evaluate(async () => {
        const open = () => Kit.open({ kind: 'center', panel: { class: 'tc-dialog' }, render: () => Kit.html`<button>Close</button>` });
        const layers = [open(), open()]; Kit.closeAll('route');
        for (const layer of layers.reverse()) { const fades = [...layer.el.children].flatMap(child => child.getAnimations().filter(animation => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition))); for (const fade of fades) fade.finish(); await Promise.all(fades.map(fade => fade.finished)); }
        return { count: document.querySelectorAll('.tc-layer').length, inert: document.getElementById('app').inert };
      });
      assert.deepEqual(closeAll, { count: 0, inert: false }, name + ': closeAll drains closing layers'); checks++;
      // Ancestor opacity can turn the layer into a new backdrop root. Check
      // actual painted pixels too: computed blur/opacity can look correct
      // while Chromium abruptly stops blurring the page behind the dialog.
      await page.evaluate(() => {
        document.getElementById('app').style.background = 'repeating-linear-gradient(90deg,white 0px,white 8px,black 8px,black 16px)';
        window.__motionTimeout = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => window.__motionTimeout(callback, delay === 200 ? 2000 : delay, ...args);
        window.__blurLayer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog' }, render: () => Kit.html`<div class="tc-dialog-body"><button>Blur check</button></div>` });
        for (const child of __blurLayer.el.children) for (const animation of child.getAnimations()) { animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration); }
      });
      const clip = { x: 20, y: 200, width: 128, height: 64 };
      const beforeBlur = await page.screenshot({ clip });
      await page.evaluate(() => {
        __blurLayer.close();
        for (const child of __blurLayer.el.children) for (const animation of child.getAnimations()) {
          if (!(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)) { animation.pause(); animation.currentTime = 0; }
        }
      });
      const duringBlur = await page.screenshot({ clip });
      const paintedDifference = await page.evaluate(async images => {
        const pixels = async source => {
          const image = new Image(); image.src = source; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height).data;
        };
        const [before, after] = await Promise.all(images.map(pixels));
        let difference = 0;
        for (let i = 0; i < before.length; i++) difference += Math.abs(before[i] - after[i]);
        return difference / before.length;
      }, [beforeBlur, duringBlur].map(buffer => 'data:image/png;base64,' + buffer.toString('base64')));
      assert(paintedDifference < 1, `${name} ${theme}: closing preserves the painted backdrop blur (pixel difference ${paintedDifference})`); checks++;
      await page.evaluate(async () => {
        const fades = [...__blurLayer.el.children].flatMap(child => child.getAnimations().filter(animation => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)));
        for (const fade of fades) fade.finish(); await Promise.all(fades.map(fade => fade.finished));
        window.setTimeout = window.__motionTimeout; document.getElementById('app').style.removeProperty('background');
      });
      const cancelled = await page.evaluate(async () => {
        const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog' }, render: () => Kit.html`<button>Cancel animation</button>` });
        layer.close();
        const fades = [...layer.el.children].flatMap(child => child.getAnimations().filter(animation => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)));
        const settled = Promise.allSettled(fades.map(fade => fade.finished));
        for (const fade of fades) fade.cancel(); await settled;
        return { count: document.querySelectorAll('.tc-layer').length, inert: document.getElementById('app').inert };
      });
      assert.deepEqual(cancelled, { count: 0, inert: false }, name + ': cancelled animations release the layer'); checks++;
      const fallback = await page.evaluate(async () => {
        const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog' }, render: () => Kit.html`<button>Paused animation</button>` });
        layer.close();
        for (const child of layer.el.children) for (const animation of child.getAnimations()) animation.pause();
        await new Promise(resolve => setTimeout(resolve, 250));
        return { count: document.querySelectorAll('.tc-layer').length, inert: document.getElementById('app').inert };
      });
      assert.deepEqual(fallback, { count: 0, inert: false }, name + ': a stalled animation cannot leave the page locked'); checks++;
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await page.evaluate(() => {
        document.getElementById('trigger').focus();
        const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog' }, render: () => Kit.html`<button>Close</button>` });
        layer.close();
        return { count: document.querySelectorAll('.tc-layer').length, inert: document.getElementById('app').inert, focused: document.activeElement.id };
      });
      assert.deepEqual(reduced, { count: 0, inert: false, focused: 'trigger' }, name + ': reduced-motion close is immediate'); checks++;
      assert.deepEqual(errors, [], name + ': no browser errors');
      await page.close(); console.log(`${name} ${theme}: closing motion, modality, focus and nested layers passed`);
    }
    console.log(`${checks} overlay motion checks passed`);
  } finally { clearTimeout(watchdog); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

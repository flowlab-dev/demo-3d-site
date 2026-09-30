// The page in headless Chrome (with the Mac's GPU): the 3D scene, the pinned
// "Inside" section, fading, theme, form, phones, reduced motion, no WebGL,
// frame rate, contrast and text widths. No packages: the DevTools protocol over
// Node's own WebSocket, and a tiny static server (modules need http://).
//
//   node --test tests/page.test.mjs          (or: npm test)
//   CHROME_PATH=/path/to/chrome node --test tests/page.test.mjs   (if Chrome lives somewhere else)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', process.env.PAGE_DIR || 'demo');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (await import('../demo/assets/logic.js')).default;

// ---------- static server ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIR, path.endsWith('/') ? path + 'index.html' : path);
  if (!file.startsWith(DIR) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

// ---------- Chrome over the DevTools protocol ----------
let chrome; let ws; let id = 0; let profile;
const waiting = new Map();
let problems = [];
let scriptId = null;

async function send(method, params = {}) {
  id += 1;
  const mine = id;
  return new Promise((resolve) => { waiting.set(mine, resolve); ws.send(JSON.stringify({ id: mine, method, params })); });
}
async function js(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
async function open({ width = 1280, height = 800, touch = false, dpr = 1, motion = '', dark = false, block = [], clearStorage = true, hash = '', before = '' } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: touch });
  await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: motion || 'no-preference' },
    { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
  ] });
  await send('Network.setBlockedURLs', { urls: block });
  if (clearStorage) await send('Storage.clearDataForOrigin', { origin: URL_.slice(0, -1), storageTypes: 'local_storage' });
  problems = [];
  if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
  scriptId = before ? (await send('Page.addScriptToEvaluateOnNewDocument', { source: before })).result.identifier : null;
  await send('Page.navigate', { url: URL_ + hash });
  await waitFor('document.readyState === "complete"');
}
async function waitFor(expr, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await js(`!!(${expr})`)) return true; } catch { /* page still loading */ }
    await sleep(50);
  }
  throw new Error('timed out waiting for ' + expr);
}
const ready = () => waitFor('window.lanternDebug && lanternDebug.ready && document.documentElement.classList.contains("webgl")');
// Scroll triggers are built on the first scroll (app.js): nudge the page, wait for the pin
async function engagePin() {
  await js('scrollTo(0, 1)');
  await waitFor('typeof ScrollTrigger !== "undefined" && ScrollTrigger.getAll().some((t) => t.pin)');
}
async function scrollToPin(progress) {
  await js(`(() => { const st = ScrollTrigger.getAll().find((t) => t.pin); scrollTo(0, st.start + (st.end - st.start) * ${progress}); })()`);
  await sleep(700);
}

test.before(async () => {
  profile = mkdtempSync(join(tmpdir(), 'lantern-test-'));
  const gpu = process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  chrome = spawn(CHROME, ['--headless', '--no-sandbox', '--hide-scrollbars', '--ignore-gpu-blocklist', ...gpu,
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)/); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('Chrome did not start')), 15000);
  });
  // Chrome reports its port a moment before its first tab is ready: ask again until it is
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not listening yet */ }
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('Chrome opened no tab');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) problems.push('console: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/GL Driver Message|blocked by the client/i.test(msg.params.entry.text)) problems.push('log: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    if (msg.method === 'Network.loadingFailed' && msg.params.blockedReason !== 'inspector') problems.push('network: ' + msg.params.errorText);
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable');
});

test.after(() => {
  try { ws.close(); } catch { /* already closed */ }
  chrome?.kill('SIGKILL');
  server.close();
  rmSync(profile, { recursive: true, force: true });
});

// ---------- tests ----------

test('desktop: the 3D scene starts, the page is clean and honest', async () => {
  await open();
  await ready();
  await sleep(800);
  assert.deepEqual(problems, [], 'no errors, warnings or failed requests');
  const head = await js(`({
    doctype: !!document.doctype && document.doctype.name, lang: document.documentElement.lang,
    charset: document.characterSet, viewport: document.querySelector('meta[name=viewport]')?.content,
    icon: document.querySelector('link[rel=icon]').href.startsWith('data:'),
    band: document.querySelector('.demo-band').textContent,
    footer: document.querySelector('.site-footer').textContent,
  })`);
  assert.equal(head.doctype, 'html');
  assert.equal(head.lang, 'en');
  assert.equal(head.charset, 'UTF-8');
  assert.equal(head.viewport, 'width=device-width, initial-scale=1');
  assert.ok(head.icon, 'the tab icon is built in, so no favicon 404');
  assert.match(head.band, /Self-initiated demo/);
  assert.match(head.band, /invented/);
  assert.match(head.footer, /every number on this page are invented/);
  const d = await js('({ renders: lanternDebug.renders, error: lanternDebug.error, holder: lanternDebug.holder() })');
  assert.ok(d.renders > 5, 'the scene keeps drawing');
  assert.equal(d.error, null);
  assert.ok(d.holder.x > 0.5, 'on a wide screen the box sits to the right of the headline');
});

test('desktop: frames stay near 60 per second', async () => {
  await open();
  await ready();
  await sleep(1500);
  const fps = await js(`(async () => { const a = lanternDebug.renders; const t = performance.now();
    await new Promise((r) => setTimeout(r, 2000)); return (lanternDebug.renders - a) / ((performance.now() - t) / 1000); })()`);
  assert.ok(fps >= 50, `about ${fps.toFixed(1)} fps`);
  assert.equal(await js('lanternDebug.quality'), 'high');
});

test('scrolling: the box glides down into "Inside", opens, and each layer takes its turn', async () => {
  await open();
  await ready();
  await engagePin();
  assert.equal(await js('lantern.blend'), 0);
  await scrollToPin(0);
  assert.equal(await js('lantern.blend.toFixed(2)'), '1.00');

  for (let i = 0; i < L.LAYERS.length; i++) {
    const p = L.stepStart(i) + L.STEP_SPAN / 2;
    await scrollToPin(p);
    await sleep(600); // the current layer eases forward
    const s = await js(`({ progress: lantern.progress, current: [...document.querySelectorAll('.step.is-current')].map((e) => +e.dataset.step), layers: lanternDebug.layers(), bar: getComputedStyle(document.querySelector('.steps__bar')).transform })`);
    assert.deepEqual(s.current, [i], `step ${i + 1} is the only current caption`);
    const expected = L.anatomy(s.progress).offsets;
    s.layers.forEach((layer, n) => assert.ok(Math.abs(layer.y - expected[n]) < 0.01, `layer ${n} at its scroll position`));
    s.layers.forEach((layer, n) => (n === i ? assert.ok(layer.z > 0.3, 'current layer steps forward') : assert.ok(layer.z < 0.05, `layer ${n} stays back`)));
    assert.notEqual(s.bar, 'none', 'progress bar follows the scroll');
  }
});

test('scrolling on: the scene fades out and stops drawing under the rest of the page', async () => {
  await open();
  await ready();
  await js(`document.getElementById('privacy').scrollIntoView({ behavior: 'instant' })`);
  await sleep(800);
  const a = await js(`({ opacity: getComputedStyle(document.getElementById('scene')).opacity, renders: lanternDebug.renders })`);
  await sleep(800);
  const b = await js('lanternDebug.renders');
  assert.equal(Number(a.opacity), 0);
  assert.equal(b, a.renders, 'no frames drawn while the scene is invisible');
  // and it comes back when scrolling up
  await js('scrollTo(0, 0)');
  await sleep(600);
  assert.equal(Number(await js(`getComputedStyle(document.getElementById('scene')).opacity`)), 1);
});

test('numbers count up to exactly the values in the page, and the captions agree with them', async () => {
  await open();
  await ready();
  await js(`document.getElementById('specs').scrollIntoView({ behavior: 'instant' })`);
  await sleep(1800);
  const v = await js(`({ shown: [...document.querySelectorAll('[data-count]')].map((e) => [e.textContent, e.dataset.count]),
    steps: document.querySelector('.steps').textContent })`);
  v.shown.forEach(([text, target]) => assert.equal(text, target));
  const tops = await js(`[...document.querySelectorAll('.spec__value')].map((e) => Math.round(e.getBoundingClientRect().top))`);
  assert.equal(new Set(tops).size, 1, 'the four numbers line up');
  // The same numbers appear in the "Inside" captions; one source of truth, checked here
  const memory = v.shown[0][1];
  const noise = v.shown[2][1];
  assert.match(v.steps, new RegExp(`${memory} GB of memory`));
  assert.match(v.steps, new RegExp(`at ${noise} dB under full load`));
});

test('theme: the switch changes colours and the scene, and is remembered', async () => {
  await open();
  await ready();
  assert.equal(await js('document.documentElement.dataset.theme'), 'light');
  await js(`document.getElementById('theme-toggle').click()`);
  await sleep(500); // colours ease over 0.3 s
  const t = await js(`({ theme: document.documentElement.dataset.theme, label: document.getElementById('theme-toggle').getAttribute('aria-label'),
    bg: getComputedStyle(document.body).backgroundColor, saved: localStorage.getItem('lantern-theme') })`);
  assert.equal(t.theme, 'dark');
  assert.equal(t.label, 'Switch to light theme');
  assert.equal(t.bg, 'rgb(20, 23, 27)');
  assert.equal(t.saved, 'dark');
  assert.deepEqual(await js(`[...document.querySelectorAll('meta[name=theme-color]')].map((m) => m.content)`), ['#14171B', '#14171B'], 'browser bars follow the chosen theme');
  await open({ clearStorage: false });
  assert.equal(await js('document.documentElement.dataset.theme'), 'dark', 'still dark after reload');
  await open({ dark: true });
  assert.equal(await js('document.documentElement.dataset.theme'), 'dark', 'follows a dark system');
});

test('contrast is at least 4.5:1 for text in both themes', async () => {
  for (const dark of [false, true]) {
    await open({ dark });
    const pairs = await js(`(() => {
      const parse = (c) => { const n = c.match(/[\\d.]+/g).map(Number); const srgb = c.startsWith('color('); return { rgb: n.slice(0, 3).map((v) => (srgb ? v * 255 : v)), a: n.length > 3 ? n[3] : 1 }; };
      const rgb = (c) => parse(c).rgb;
      const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      // The first ancestor with a (nearly) solid background is what the text sits on
      const bg = (el) => { while (el && parse(getComputedStyle(el).backgroundColor).a < 0.9) el = el.parentElement; return getComputedStyle(el || document.body).backgroundColor; };
      return ['.hero__title', '.hero__lead', '.nav a', '.demo-band', '.button--primary', '.button--quiet', '.step__title', '.step__body', '.step:not(.is-current) .step__title', '.step:not(.is-current) .step__body', '.spec__label', '.row__body', '.price__note', '.site-footer__note', '.field label']
        .map((sel) => { const el = document.querySelector(sel); return [sel, +ratio(getComputedStyle(el).color, bg(el)).toFixed(2)]; });
    })()`);
    pairs.forEach(([sel, r]) => assert.ok(r >= 4.5, `${dark ? 'dark' : 'light'} ${sel}: ${r}:1`));
  }
});

test('reservation form: errors in words, focus on the first problem, honest confirmation', async () => {
  await open();
  await js(`document.getElementById('reserve').scrollIntoView({ behavior: 'instant' })`);
  await js(`document.querySelector('.form__submit').click()`);
  let f = await js(`({ invalid: [...document.querySelectorAll('[aria-invalid=true]')].map((e) => e.name), focus: document.activeElement.name,
    errors: [...document.querySelectorAll('.field__error:not([hidden])')].map((e) => e.textContent), done: document.getElementById('reserve-done').hidden })`);
  assert.deepEqual(f.invalid, ['name', 'email', 'team']);
  assert.equal(f.focus, 'name');
  assert.deepEqual(f.errors, ['Enter your name.', 'Enter your work email.', 'Choose your team size.']);
  assert.equal(f.done, true);

  await js(`(() => { const s = (n, v) => { const el = document.querySelector('[name=' + n + ']'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    s('name', 'Ada Park'); s('email', 'ada@'); s('team', '11-50'); })()`);
  f = await js(`[...document.querySelectorAll('[aria-invalid=true]')].map((e) => e.name)`);
  assert.deepEqual(f, ['email'], 'fixed fields clear their error while typing');
  await js(`document.querySelector('.form__submit').click()`);
  assert.equal(await js('document.activeElement.name'), 'email');

  await js(`(() => { const el = document.querySelector('[name=email]'); el.value = 'ada@parklaw.example'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`document.querySelector('.form__submit').click()`);
  f = await js(`({ done: document.getElementById('reserve-done'), text: document.getElementById('reserve-done').textContent, focus: document.activeElement.id,
    invalid: document.querySelectorAll('[aria-invalid=true]').length })`);
  assert.equal(f.focus, 'reserve-done');
  assert.equal(f.invalid, 0);
  assert.match(f.text, /Thanks, Ada Park\. This is a demo, so nothing was sent\./);
  assert.match(f.text, /team of 11–50 people/);
  assert.match(f.text, /ada@parklaw\.example/);
  // Changing the details hides the old confirmation, so it never describes data that is gone
  await js(`(() => { const el = document.querySelector('[name=name]'); el.value = 'Ada P.'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await js(`document.getElementById('reserve-done').hidden`), true);
});

test('phone 390x844: box above the headline, no sideways scroll, lighter quality', async () => {
  await open({ width: 390, height: 844, touch: true, dpr: 3 });
  await ready();
  const p = await js(`({ sw: document.documentElement.scrollWidth, q: lanternDebug.quality, holder: lanternDebug.holder(),
    art: document.querySelector('.hero__art').getBoundingClientRect().top < document.querySelector('.hero__title').getBoundingClientRect().top,
    header: [document.querySelector('.wordmark').getBoundingClientRect().left, innerWidth - document.getElementById('theme-toggle').getBoundingClientRect().right] })`);
  assert.equal(p.sw, 390);
  assert.equal(p.q, 'medium');
  assert.ok(p.art, 'box first, then the headline');
  assert.ok(Math.abs(p.holder.x) < 0.05, 'box centred');
  assert.ok(p.header[0] >= 16 && p.header[1] >= 16, 'header keeps its side margins');
  assert.match(await js(`document.querySelector('.hero__hint').textContent`), /^(Tap the box, then tilt your device: it follows\.|Tilt your device: the box follows\.)$/, 'no mention of a pointer on a phone');
  await js(`window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 70, gamma: 10 }))`);
  assert.equal(await js(`document.querySelector('.hero__hint').textContent`), 'Tilt your device: the box follows.', 'once tilt arrives the hint drops the tap');
  assert.ok(await js('lantern.pointer.x > 0 && lantern.pointer.y > 0'), 'tilt turns the box');
  const fps = await js(`(async () => { const a = lanternDebug.renders; const t = performance.now();
    await new Promise((r) => setTimeout(r, 2000)); return (lanternDebug.renders - a) / ((performance.now() - t) / 1000); })()`);
  assert.ok(fps >= 50, `about ${fps.toFixed(1)} fps at 3x pixel density`);
});

test('phone with Safari bars (390x660): the pinned section fits, one caption at a time', async () => {
  await open({ width: 390, height: 660, touch: true, dpr: 3 });
  await ready();
  await engagePin();
  for (let i = 0; i < L.LAYERS.length; i++) {
    await scrollToPin(L.stepStart(i) + L.STEP_SPAN / 2);
    const s = await js(`(() => { const cur = document.querySelector('.step.is-current'); const r = cur.getBoundingClientRect();
      const others = [...document.querySelectorAll('.step:not(.is-current)')].map((e) => getComputedStyle(e).opacity);
      return { i: +cur.dataset.step, bottom: r.bottom, top: r.top, h: innerHeight, others, font: parseFloat(getComputedStyle(cur.querySelector('.step__body')).fontSize),
        art: document.querySelector('.inside__art').getBoundingClientRect().bottom }; })()`);
    assert.equal(s.i, i);
    assert.ok(s.bottom <= s.h, `caption ${i + 1} ends at ${s.bottom}px, screen is ${s.h}px`);
    assert.ok(s.top >= s.art, 'caption is below the box');
    assert.ok(s.others.every((o) => Number(o) === 0), 'other captions are out of the way');
    assert.ok(s.font >= 16, 'caption text is readable');
  }
  assert.equal(await js('document.documentElement.scrollWidth'), 390);
});

test('reduced motion: nothing moves or pins, all content is visible at once', async () => {
  await open({ motion: 'reduce' });
  await ready();
  const r = await js(`({ motion: document.documentElement.classList.contains('motion'), pinned: lantern.pinned,
    spacers: document.querySelectorAll('.pin-spacer').length, insideArt: getComputedStyle(document.querySelector('.inside__art .art__svg')).visibility,
    steps: [...document.querySelectorAll('.step')].map((e) => getComputedStyle(e).opacity), counts: [...document.querySelectorAll('[data-count]')].map((e) => e.textContent) })`);
  assert.equal(r.motion, false);
  assert.equal(r.pinned, false);
  assert.equal(r.spacers, 0);
  assert.equal(r.insideArt, 'visible', 'the drawing shows the four layers instead');
  assert.deepEqual(r.steps, ['1', '1', '1', '1']);
  assert.deepEqual(r.counts, ['128', '70', '31', '240']);
  const a = await js('lanternDebug.renders');
  await js(`document.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }))`);
  await sleep(800);
  assert.equal(await js('lanternDebug.renders'), a, 'a still page is not redrawn');
  assert.deepEqual(problems, []);
});

test('no 3D library (blocked or offline CDN): drawings instead, a normal page, form still works', async () => {
  await open({ block: ['*three*'] });
  await waitFor('document.documentElement.classList.contains("no-webgl")');
  await js('scrollTo(0, 1)');
  await waitFor('typeof ScrollTrigger !== "undefined" && ScrollTrigger.getAll().length > 0');
  const n = await js(`({ hero: getComputedStyle(document.querySelector('.hero__art .art__svg')).visibility, inside: getComputedStyle(document.querySelector('.inside__art .art__svg')).visibility,
    pin: document.querySelectorAll('.pin-spacer').length, canvas: getComputedStyle(document.getElementById('scene')).opacity, steps: [...document.querySelectorAll('.step')].map((e) => getComputedStyle(e).opacity) })`);
  assert.equal(n.hero, 'visible');
  assert.equal(n.inside, 'visible');
  assert.equal(n.pin, 0);
  assert.equal(Number(n.canvas), 0);
  assert.deepEqual(n.steps, ['1', '1', '1', '1']);
  await js(`document.querySelector('.form__submit').click()`);
  assert.equal(await js('document.querySelectorAll("[aria-invalid=true]").length'), 3);
});

test('text columns are readable: not squeezed, not too long', async () => {
  for (const width of [1280, 1440, 1920]) {
    await open({ width, height: 900 });
    const bad = await js(`[...document.querySelectorAll('main p, .step__body, .row__body')].filter((p) => p.offsetParent && p.textContent.trim().length > 90)
      .map((p) => { const w = p.getBoundingClientRect().width; const em = parseFloat(getComputedStyle(p).fontSize); return [p.textContent.slice(0, 30), Math.round(w), +(w / em).toFixed(1)]; })
      .filter(([, w, ems]) => w < 240 || ems > 38)`);
    assert.deepEqual(bad, [], `at ${width}px: [text, width, width in em]`);
  }
});

test('keyboard: skip link, visible focus, and "See inside" goes to the section', async () => {
  await open();
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const k = await js(`({ el: document.activeElement.className, top: document.activeElement.getBoundingClientRect().top })`);
  assert.equal(k.el, 'skip-link');
  assert.ok(k.top >= 0, 'skip link comes into view when focused');
  await js(`document.querySelector('a[href="#inside"].button').click()`);
  await sleep(1500);
  assert.ok(await js(`Math.abs(document.getElementById('inside').getBoundingClientRect().top) < 5`));
});

// ---------- added after the fresh-eyes review ----------

const boxFits = (slot) => `(() => { const b = lanternDebug.screenBox(); const r = document.querySelector('${slot}').getBoundingClientRect();
  return { b, r: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, vw: innerWidth, vh: innerHeight }; })()`;

test('the box stays inside its slot and on screen, from phone to wide desktop', async () => {
  for (const [width, height, touch] of [[390, 844, true], [768, 1024, true], [1024, 1366, true], [1280, 800, false], [1920, 1080, false], [2560, 1080, false]]) {
    await open({ width, height, touch, dpr: touch ? 2 : 1 });
    await ready();
    await sleep(300);
    const { b, r, vw } = await js(boxFits('.hero__art'));
    const tol = 12;
    assert.ok(b.left >= r.left - tol && b.right <= r.right + tol, `${width}x${height}: box ${b.left | 0}-${b.right | 0} within slot ${r.left | 0}-${r.right | 0}`);
    assert.ok(b.left >= 0 && b.right <= vw, `${width}x${height}: box on screen`);
  }
});

test('phone on its side (844x390) and a low laptop window (1366x657): the pinned section fits', async () => {
  for (const [width, height, touch] of [[844, 390, true], [1366, 657, false]]) {
    await open({ width, height, touch, dpr: touch ? 3 : 1 });
    await ready();
    await engagePin();
    for (let i = 0; i < L.LAYERS.length; i++) {
      await scrollToPin(L.stepStart(i) + L.STEP_SPAN / 2);
      const s = await js(`(() => { const cur = document.querySelector('.step.is-current'); const r = cur.getBoundingClientRect();
        const bar = document.querySelector('.steps__progress').getBoundingClientRect(); const title = document.querySelector('#inside-title').getBoundingClientRect();
        return { i: +cur.dataset.step, bottom: r.bottom, bar: bar.bottom, title: title.top, h: innerHeight, box: lanternDebug.screenBox() }; })()`);
      assert.equal(s.i, i);
      assert.ok(s.bottom <= s.h && s.bar <= s.h, `${width}x${height} step ${i + 1}: caption ends ${s.bottom | 0}, bar ${s.bar | 0}, screen ${s.h}`);
      assert.ok(s.title >= 0, 'heading not cut at the top');
      assert.ok(s.box.top >= -4 && s.box.bottom <= s.h + 4, `${width}x${height} step ${i + 1}: box ${s.box.top | 0}-${s.box.bottom | 0} on screen`);
    }
  }
});

test('GSAP missing but WebGL fine: a normal page, all captions shown, the scene stops below the hero', async () => {
  await open({ block: ['*gsap*'], width: 390, height: 844, touch: true, dpr: 2 });
  await ready();
  const n = await js(`({ pinned: document.documentElement.classList.contains('pinned'), steps: [...document.querySelectorAll('.step')].map((e) => getComputedStyle(e).opacity),
    art: getComputedStyle(document.querySelector('.inside__art .art__svg')).visibility })`);
  assert.equal(n.pinned, false);
  assert.deepEqual(n.steps, ['1', '1', '1', '1']);
  assert.equal(n.art, 'visible', 'the "Inside" drawing is shown');
  await js(`document.getElementById('reserve').scrollIntoView({ behavior: 'instant' })`);
  await sleep(500);
  const a = await js('lanternDebug.renders');
  await sleep(700);
  assert.equal(await js('lanternDebug.renders'), a, 'no drawing while the scene is out of sight');
  assert.equal(Number(await js(`getComputedStyle(document.getElementById('scene')).opacity`)), 0);
});

test('a link straight to a section (/#reserve) lands on it', async () => {
  await open({ hash: '#reserve' });
  await ready();
  await sleep(1200);
  const top = await js(`document.getElementById('reserve').getBoundingClientRect().top`);
  assert.ok(Math.abs(top) < 5, `#reserve is at ${top}px from the top`);
});

test('iPhone-style tilt permission is asked only by a tap on the box, never by the buttons', async () => {
  const stub = `window.__asked = 0; window.DeviceOrientationEvent = window.DeviceOrientationEvent || function () {};
    DeviceOrientationEvent.requestPermission = () => { window.__asked++; return Promise.resolve('denied'); };`;
  await open({ width: 390, height: 844, touch: true, dpr: 2, before: stub });
  await ready();
  assert.equal(await js(`document.querySelector('.hero__hint').textContent`), 'Tap the box, then tilt your device: it follows.');
  await js(`document.querySelector('.hero .button--primary').addEventListener('click', (e) => e.preventDefault(), { once: true }); document.querySelector('.hero .button--primary').click()`);
  await js(`document.querySelector('.hero .button--quiet').addEventListener('click', (e) => e.preventDefault(), { once: true }); document.querySelector('.hero .button--quiet').click()`);
  assert.equal(await js('window.__asked'), 0, 'buttons do not trigger the permission prompt');
  await js(`document.querySelector('.hero__art').click()`);
  await sleep(100);
  assert.equal(await js('window.__asked'), 1);
  assert.equal(await js(`getComputedStyle(document.querySelector('.hero__hint')).visibility`), 'hidden', 'after "no" the hint no longer promises tilt');
});

test('nothing heavy happens at load: scroll triggers are built on the first scroll', async () => {
  await open();
  await ready();
  await sleep(600);
  assert.equal(await js('typeof ScrollTrigger !== "undefined" ? ScrollTrigger.getAll().length : -1'), 0, 'no triggers before the visitor moves');
  assert.equal(await js('document.querySelectorAll(".pin-spacer").length'), 0);
  await engagePin();
  assert.equal(await js('document.documentElement.classList.contains("pinned")'), true);
});

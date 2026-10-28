// page.spec.mjs - the Lua web page (console and notebook) in real browsers, with Playwright
//
// Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
// Copyright Notice in lua.h).
//
// usage: node page.spec.mjs WEB_DIR
//
// A plain node script (no @playwright/test, no package.json: Playwright
// is a test tool, installed outside the repository).  It serves WEB_DIR
// (emscripten/build/web, or the bundle the workflow assembles) over HTTP
// with no COOP/COEP headers, like GitHub Pages, and drives the page in
// each browser named by BROWSERS (default "chromium"; e.g.
// BROWSERS=chromium,firefox,webkit).  Environment:
//
//   PLAYWRIGHT_MODULE  the playwright package to use, as a path (e.g.
//                      $RUNNER_TEMP/pw/node_modules/playwright); default:
//                      resolve "playwright" from here
//   SHOTS              if set, a directory for screenshots: of every failed
//                      check, and of the console and the notebook (light
//                      and dark, desktop and 360 px wide)
//   ONLY               if set, a regular expression: only the checks whose
//                      name matches run (the page is still loaded)
//   QUERIES            if set, the pages to test instead of the default
//                      ones, comma-separated (e.g. "?arch=wasm64,?arch=wasm32")
//   PAGE_URL           if set, the URL of a server already serving WEB_DIR
//                      (e.g. deploy/serve.py run in the bundle), tested
//                      instead of the script's own server
//
// The usual Playwright variables apply (PLAYWRIGHT_BROWSERS_PATH, ...).
// For each browser it tests the default page and the page with
// ?arch=wasm32 (cases P1-P22 of the design's test plan, and the
// lettered ones added since, such as P5b); a browser without memory64
// (WebKit) gets the wasm32 build on the default page,
// with a note saying why, and is tested on that page only.  Exits with
// status 1 if any check fails or the page logs a console error (on a
// wasm64 page also Firefox's warning about legacy exception handling,
// which only the wasm32 build uses; on wasm32 pages those are counted).
//
// Run locally:
//   npm install --no-save --prefix "$SCRATCH/pw" playwright@1.64.0
//   "$SCRATCH/pw/node_modules/.bin/playwright" install chromium firefox
//   make -C emscripten page-test PLAYWRIGHT_MODULE="$SCRATCH/pw/node_modules/playwright"

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const webDir = path.resolve(process.argv[2] || 'build/web');
const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
const pageMeta = name => (new RegExp('<meta name="' + name + '" content="([^"]*)">').exec(html) || [])[1];
// "ARCH:EH" each, the first one beside index.html (design §3)
const builds = (pageMeta('lua-wasm-builds') || '').split(/\s+/).filter(Boolean)
  .map(w => { const [a, e] = w.split(':'); return { arch: a, eh: e }; });
if (!builds.length || builds.some(b => !/^wasm(32|64)$/.test(b.arch)))
  throw new Error('no lua-wasm-builds meta in ' + webDir + '/index.html (is it a built page?)');
const has32 = builds.some(b => b.arch === 'wasm32');
const browsers = (process.env.BROWSERS || 'chromium').split(',').map(s => s.trim()).filter(Boolean);
const BANNER = 'Lua 5.5.1  Copyright (C) 1994-2026 Lua.org, PUC-Rio';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8',
                '.txt': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = path.join(webDir, path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '') || 'index.html');
  const f = p.endsWith(path.sep) ? path.join(p, 'index.html') : p;
  if (!f.startsWith(webDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
let base;
if (process.env.PAGE_URL) {
  base = new URL(process.env.PAGE_URL).href.replace(/[^/]*$/, '');
} else {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port + '/';
}

let failures = 0, passes = 0, shotN = 0;
let shotPage = null, shotName = '';
async function check(name, f) {
  if (only && !only.test(name)) return;
  try {
    await f();
    passes++;
    console.log('ok - ' + name);
  } catch (e) {
    failures++;
    console.log('not ok - ' + name + '\n  ' + String((e && e.message) || e).split('\n').join('\n  '));
    if (shots && shotPage) {
      fs.mkdirSync(shots, { recursive: true });
      const file = path.join(shots, `${shotName}-failed-${++shotN}.png`);
      await shotPage.screenshot({ path: file, fullPage: false }).catch(() => {});
      console.log('  # screenshot ' + file);
    }
  }
}
function assert(c, msg) { if (!c) throw new Error('assertion failed: ' + msg); }
const J = x => JSON.stringify(x);
// a Lua string literal for s
const lua = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The notebook's DOM (notebook.js, design §6.2: chicken's, ported)
const NB = {
  cells: '#nb-cells > li', src: '.nb-src', hl: '.nb-hl', out: '.nb-out', value: '.nb-value', count: '.nb-count',
  rich: '.nb-rich', stdin: '.nb-stdin', stdinText: '.nb-stdin-text', status: '#nb-status', statusText: '#nb-status-text',
  runAll: '#nb-run-all', stop: '#nb-stop', restart: '#nb-restart', more: '#nb-more', menu: '#nb-menu', file: '#nb-file',
  endCode: '#nb-end-code', notice: '#nb-notice', noticeText: '#nb-notice-text', shortcuts: '#nb-shortcuts',
  info: '#nb-info', panel: '#nb-panel',
};

// Does this engine validate a 64-bit memory (the page's own probe)?
async function engineHasMemory64(page) {
  return page.evaluate(() => WebAssembly.validate(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 4, 0])));
}

async function runTarget(browser, bname, target) {
  // target: { query: '' | '?arch=wasm32', arch: the build that must run, note: a RegExp or null }
  const T = bname + (target.query ? ' ' + target.query : '') + ': ';
  shotName = bname + (target.query ? '-' + (target.arch || 'query') : '-default');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  shotPage = page;
  const errors = [], legacyEh = [], requests = [], dialogs = [];
  const isLegacyEh = m => m.type() === 'warning' && /exception handling 'try' instruction is deprecated/.test(m.text());
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
    if (isLegacyEh(m)) legacyEh.push(m.text());
  });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('worker', w => { if (typeof w.on === 'function') w.on('console', m => {
    if (m.type() === 'error') errors.push('worker console: ' + m.text());
    if (isLegacyEh(m)) legacyEh.push(m.text());
  }); });
  page.on('requestfailed', r => errors.push('request failed: ' + r.url()));
  page.on('request', r => requests.push(r.url()));
  // an unexpected alert() (the sanitizer cases) is a failure; confirm()s are accepted
  page.on('dialog', d => {
    if (d.type() === 'alert') { dialogs.push(d.message()); d.dismiss().catch(() => {}); }
    else d.accept().catch(() => {});
  });

  const term = () => page.$eval('#term', e => e.textContent);
  const pill = () => page.$eval('#status', e => e.dataset.state);
  const waitPill = (st, timeout = 20000) =>
    page.waitForFunction(s => document.getElementById('status').dataset.state === s, st, { timeout });
  let markAt = 0;
  const mark = async () => { markAt = (await term()).length; };
  const since = async () => (await term()).slice(markAt);
  const waitSince = (re, timeout = 20000) =>
    page.waitForFunction(([src, fl, at]) => new RegExp(src, fl).test(document.getElementById('term').textContent.slice(at)),
                         [re.source, re.flags, markAt], { timeout });
  async function enter(text) {
    await mark();
    await page.fill('#line', text);
    await page.press('#line', 'Enter');
  }
  // a console line; resolves when its output matches re and the pill is back at ready
  async function evalTo(text, re, timeout) {
    await enter(text);
    await waitSince(re, timeout);
    await waitPill('ready', timeout);
  }
  async function settings(f) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings[open]');
    await f();
    await mark();
    await page.click('#settings button[value="save"]');
  }

  await check(T + `P1 the page loads, runs ${target.arch} and the pill reaches ready within 30 s`, async () => {
    const t0 = Date.now();
    await page.goto(base + 'index.html' + target.query);
    eq(await page.title(), 'Lua console', 'title');
    await waitPill('ready', 30000);
    console.log('  # ready after ' + (Date.now() - t0) + ' ms');
    // the chip is shown on a page with several builds
    if (builds.length > 1)
      assert(await page.isVisible('#arch') && (await page.textContent('#arch')).trim() === target.arch,
             'the header chip: ' + await page.textContent('#arch'));
    eq(await page.evaluate(() => window.LuaPage && LuaPage.ARCH), target.arch, 'LuaPage.ARCH');
    if (target.note) assert(target.note.test(await term()), 'the arch note: ' + (await term()).slice(0, 300));
  });
  if (await page.$eval('#status', e => e.dataset.state).catch(() => '') !== 'ready') {
    console.log('  # the page did not start: skipping the rest of ' + T);
    await context.close();
    return;
  }

  await check(T + 'P2 the banner, then the prompt "> "', async () => {
    assert((await term()).includes(BANNER), 'banner: ' + (await term()).slice(0, 300));
    eq(await page.$$eval('#term .p', l => l.length && l[l.length - 1].textContent), '> ', 'the prompt span');
  });

  await check(T + 'P3 1+1 and Enter gives 2; ArrowUp recalls it', async () => {
    await evalTo('1+1', /\n2\n/);
    assert(/> 1\+1\n/.test(await term()), 'input echoed after the prompt');
    await page.focus('#line');
    await page.press('#line', 'ArrowUp');
    eq(await page.inputValue('#line'), '1+1', 'history');
    await page.press('#line', 'ArrowDown');
    eq(await page.inputValue('#line'), '', 'back to the draft');
  });

  await check(T + 'P22 the pill: "continue" inside a statement, "ready" after it', async () => {
    await enter('for i = 1, 2 do');
    await waitPill('continue');
    eq((await page.textContent('#status-text')).trim(), 'statement continues', 'pill text');
    await enter('end');
    await waitPill('ready');
  });

  await check(T + 'P3b continuation lines, several values, print, runtime and syntax errors', async () => {
    await enter('function sq(x)');
    await waitPill('continue');
    // (the pill follows the worker's state at once, the text the next frame)
    await page.waitForFunction(() => { const l = document.querySelectorAll('#term .p');
                                       return l.length && l[l.length - 1].textContent === '>> '; });
    await enter('return x * x end');
    await waitPill('ready');
    await evalTo('sq(12), "s", nil', /\n144\ts\tnil\n/);
    await evalTo('print(1, "a", true)', /\n1\ta\ttrue\n/);
    await evalTo('error("boom")', /stdin:1: boom\nstack traceback:\n/);
    await evalTo('x = = 1', /stdin:1: unexpected symbol near '='\n/);
    await evalTo('sq(3)', /\n9\n/);
  });

  await check(T + 'P4 an endless loop is stopped by Esc, Ctrl+C and the Stop button', async () => {
    for (const how of ['Esc', 'Ctrl+C', 'Stop']) {
      await enter('while true do end');
      await waitPill('running');
      await page.waitForTimeout(300);
      const t = Date.now();
      if (how === 'Esc') await page.press('#line', 'Escape');
      else if (how === 'Ctrl+C') await page.press('#line', 'Control+c');
      else await page.click('#stop');
      await waitSince(/interrupted!/, 5000);
      assert(Date.now() - t < 5000, how + ' within 5 s');
      await waitPill('ready');
    }
    await evalTo('2+2', /\n4\n/);
  });

  await check(T + 'P5 io.read: the pill says waiting for input, the typed line is read', async () => {
    await enter('print(io.read())');
    await waitPill('waiting');
    eq((await page.textContent('#status-text')).trim(), 'waiting for input', 'pill text');
    await mark();
    await page.fill('#line', 'hi');
    await page.press('#line', 'Enter');
    await waitSince(/hi\n[\s\S]*> $/);
    await waitPill('ready');
    assert(/(^|\n)hi\n/.test(await since()), 'printed: ' + J(await since()));
  });

  await check(T + 'P6 an uploaded module is required', async () => {
    await mark();
    await page.setInputFiles('#upload', { name: 'm.lua', mimeType: 'text/plain', buffer: Buffer.from('return 7') });
    await waitSince(/-- uploaded m\.lua \(8 bytes\): dofile\("m\.lua"\) or require "m"/);
    await evalTo('require "m"', /\n7(\t|\n)/);
  });

  await check(T + 'P20 deep C recursion ends in "C stack overflow", never in a crash', async () => {
    for (const code of [
      'local t = setmetatable({}, {__index = function(t, k) return t[k] end}) print(pcall(function() return t.x end))',
      'local function f(s) return (s:gsub(".", f)) end print(pcall(f, "a"))',
      'local function f() return pcall(f) end print(select(-1, f()))',
      'print(load(("("):rep(1000) .. "1" .. (")"):rep(1000)))',
    ]) {
      await evalTo(code, /C stack overflow[^\n]*\n[\s\S]*> $/, 60000);
      assert(!/crash/.test(await since()), 'no crash: ' + (await since()).slice(-300));
    }
    await evalTo('1+1', /\n2\n/);
  });

  await check(T + 'P6b a file dropped outside the drop targets is refused: the page stays', async () => {
    const r = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x = 1'], 'dropped.lua'));
      const at = document.querySelector('header.top');
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
      at.dispatchEvent(over);
      const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      at.dispatchEvent(drop);
      return [over.defaultPrevented, drop.defaultPrevented];
    });
    eq(r, [true, true], 'dragover and drop cancelled');
    assert(!/dropped\.lua/.test(await term()), 'not uploaded');
  });

  await check(T + 'P6c an upload pending when the watchdog restarts reaches the new interpreter', async () => {
    // a C call that never yields: only the watchdog ends it
    await enter('print(string.find(string.rep("a", 3e4), ".-.-.-.-b"))');
    await waitPill('running');
    await page.setInputFiles('#upload', { name: 'late.lua', mimeType: 'text/plain', buffer: Buffer.from('return 42\n') });
    await page.press('#line', 'Escape');
    await waitSince(/-- interpreter restarted \(state lost\)/, 15000);
    await waitSince(/-- uploaded late\.lua [^\n]*new interpreter/, 15000);
    assert(!/upload of late\.lua failed/.test(await since()), 'not reported as failed: ' + J((await since()).slice(-300)));
    await waitPill('ready', 60000);
    await evalTo('require "late"', /\n42\t/);   // (and the loader data)
  });

  await check(T + 'P5b an EOF that ends an io.read does not end the session; os.exit(0) then says so', async () => {
    await enter('print(io.read("l"))');
    await waitPill('waiting');
    await page.press('#line', 'Control+d');
    await waitSince(/nil\n[\s\S]*> $/);
    await waitPill('ready');
    await enter('os.exit(0)');
    await waitSince(/-- process exited \(code 0\)/);
    await mark();
    await page.click('#restart');
    await waitSince(new RegExp(escRe(BANNER) + '[\\s\\S]*> $'), 60000);
    await waitPill('ready', 60000);
  });

  await check(T + 'P7b the Restart button gives a fresh interpreter', async () => {
    await evalTo('keep = 5', /> $/);
    await mark();
    await page.click('#restart');
    await waitSince(new RegExp(escRe(BANNER) + '[\\s\\S]*> $'), 60000);
    await waitPill('ready', 60000);
    await evalTo('keep', /\nnil\n/);
  });

  await check(T + 'P7c Restart at a prompt: the new banner follows the note, with no old prompt', async () => {
    await evalTo('1', /> $/);
    await mark();
    await page.click('#restart');
    await waitSince(new RegExp(escRe(BANNER) + '[\\s\\S]*> $'), 60000);
    await waitPill('ready', 60000);
    const t = await since();
    assert(/-- restarting…\nLua 5\.5/.test(t) && !/> Lua 5/.test(t), 'after Restart: ' + J(t.slice(0, 120)));
  });

  await check(T + 'P7d Enter in a Settings field saves (Cancel comes first in the form)', async () => {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings[open]');
    await page.fill('#set-args', '-e "print(123)"');
    await mark();
    await page.press('#set-args', 'Enter');
    await page.waitForFunction(() => !document.getElementById('settings').open);
    // (the dialog's close event, which stores the settings, is a task of its own)
    await page.waitForFunction(() => document.getElementById('settings').returnValue !== '', null, { timeout: 5000 });
    eq(await page.$eval('#settings', d => d.returnValue), 'save', 'closed by Save');
    await page.waitForFunction(() => localStorage.getItem('lua-web.args') !== null, null, { timeout: 5000 });
    eq(await page.evaluate(() => localStorage.getItem('lua-web.args')), '-e "print(123)"', 'stored');
    await waitSince(/(^|\n)123\n[\s\S]*> $/, 60000);
    await waitPill('ready', 60000);
    await settings(() => page.fill('#set-args', ''));
    await waitSince(/> $/, 60000);
    await waitPill('ready', 60000);
  });

  await check(T + 'P7 Settings: the init code runs after a restart; the dark theme', async () => {
    await settings(() => page.fill('#set-init', 'greet = "hey"'));
    await waitSince(/> $/, 60000);
    await waitPill('ready', 60000);
    await evalTo('greet', /\nhey\n/);
    const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    const light = await bg();
    await settings(async () => { await page.fill('#set-init', ''); await page.check('input[name="theme"][value="dark"]'); });
    await waitPill('ready', 60000);
    eq(await page.getAttribute('html', 'data-theme'), 'dark', 'data-theme');
    assert(await bg() !== light, '--bg changed: ' + light + ' -> ' + await bg());
    await settings(() => page.check('input[name="theme"][value="auto"]'));
    await waitPill('ready', 60000);
  });

  await check(T + 'P21 smart quotes are straightened when the setting is on', async () => {
    await settings(() => page.check('#set-quotes'));
    await waitPill('ready', 60000);
    await evalTo('print(“hi”)', /\nhi\n/);
  });

  await check(T + 'P18 no horizontal scroll at 360 px', async () => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(200);
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    await page.setViewportSize({ width: 1280, height: 800 });
    assert(w[0] <= w[1], 'scrollWidth ' + w[0] + ' > clientWidth ' + w[1]);
  });

  await check(T + 'P19 every toolbar button has an accessible name; tabs are ARIA tabs', async () => {
    const nameless = await page.evaluate(() => [...document.querySelectorAll('header button, #toolbar button, #nb-toolbar button')]
      .filter(b => !(b.getAttribute('aria-label') || b.textContent.trim() || b.title || b.getAttribute('aria-labelledby')))
      .map(b => b.outerHTML.slice(0, 80)));
    assert(!nameless.length, 'nameless: ' + nameless.join('\n'));
    const tabs = await page.$$eval('[role="tab"]', l => l.map(t => [t.id, t.getAttribute('aria-selected')]));
    eq(tabs.map(t => t[0]), ['tab-console', 'tab-notebook'], 'tabs');
    assert(tabs.every(t => t[1] === 'true' || t[1] === 'false'), 'aria-selected: ' + J(tabs));
  });

  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.click('#clear');
    await evalTo('function fact(n) if n <= 1 then return 1 end return n * fact(n - 1) end', /> $/);
    await evalTo('fact(20)', /2432902008176640000/);
    await evalTo('error("oops")', /oops/);
    await page.fill('#line', 'for i = 1, 3 do');
    await page.mouse.move(0, 0);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, `${shotName}-console-${scheme}-desktop.png`) });
      await page.setViewportSize({ width: 360, height: 740 });
      await page.screenshot({ path: path.join(shots, `${shotName}-console-${scheme}-360.png`) });
    }
    await page.fill('#line', '');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  // ---- the Notebook tab

  const NB_DONE = /^(ok|error|interrupted|cancelled)$/;
  const nbCells = () => page.$$eval(NB.cells, l => l.length);
  const nbCell = i => page.locator(NB.cells).nth(i);
  const nbSrc = i => nbCell(i).locator(NB.src);
  const nbWait = (i, re = NB_DONE, timeout = 30000) =>
    page.waitForFunction(([sel, i, s, f]) => {
      const li = document.querySelectorAll(sel)[i];
      return !!li && new RegExp(s, f).test(li.dataset.status);
    }, [NB.cells, i, re.source, re.flags], { timeout });
  const nbStatus = i => nbCell(i).getAttribute('data-status');
  const nbOut = i => nbCell(i).locator(NB.out).textContent();
  const waitNbStatus = (re, timeout = 30000) =>
    page.waitForFunction(([sel, s, f]) => new RegExp(s, f).test(document.querySelector(sel).dataset.state),
                         [NB.status, re.source, re.flags], { timeout });
  async function nbNew(src) {           // a new code cell at the end; its index
    await page.click(NB.endCode);
    const i = (await nbCells()) - 1;
    if (src != null) await nbSrc(i).fill(src);
    return i;
  }
  async function nbRun(i, key = 'Control+Enter') { await nbSrc(i).press(key); }
  async function nbEval(src, timeout) { // run src in a new cell, wait for the end
    const i = await nbNew(src);
    await nbRun(i);
    await nbWait(i, NB_DONE, timeout);
    return i;
  }
  async function menu(label) {
    await page.click(NB.more);
    await page.click(`${NB.menu} [role="menuitem"]:has-text("${label}")`);
  }

  await check(T + 'P9 the example notebook: Run all stops at the error cell', async () => {
    await page.click('#tab-notebook');
    await waitNbStatus(/^ready$/, 60000);
    assert(/^Lua 5\.5\.1 · wasm(32|64)$/.test((await page.textContent(NB.info)).trim()), 'info ' + await page.textContent(NB.info));
    const types = await page.$$eval(NB.cells, l => l.map(e => e.dataset.type));
    assert(types.length >= 8 && types[0] === 'markdown' && types.includes('code'), 'example loaded: ' + types);
    await page.click(NB.runAll);
    await page.waitForFunction(sel => {
      const l = [...document.querySelectorAll(sel + '[data-type="code"]')];
      return l.length && l.some(e => e.dataset.status === 'error') &&
        l.every(e => /^(ok|error|cancelled|interrupted)$/.test(e.dataset.status) || !e.dataset.status);
    }, NB.cells, { timeout: 90000 });
    const cells = await page.$$eval(NB.cells + '[data-type="code"]', l => l.map(e => ({ st: e.dataset.status, text: e.textContent })));
    const bad = cells.findIndex(c => c.st === 'error');
    assert(bad > 0 && cells.slice(0, bad).every(c => c.st === 'ok'), 'ok up to the error cell: ' + J(cells.map(c => c.st)));
    assert(/Traceback/.test(cells[bad].text) && /In\[/.test(cells[bad].text), 'a Traceback with In[: ' + cells[bad].text.slice(0, 300));
    assert(cells.some(c => /2432902008176640000/.test(c.text)), 'the fact(20) cell shows its value');
    assert(cells.slice(bad + 1).length && cells.slice(bad + 1).every(c => /Not run/.test(c.text)),
           'cells after it say Not run: ' + J(cells.slice(bad + 1).map(c => c.text.slice(0, 80))));
  });

  await check(T + 'P10 an SVG element tree renders inside .nb-rich, with no script', async () => {
    const i = await nbEval('notebook.svg{"svg", viewBox="0 0 10 10", {"rect", width=10, height=10, style="fill: var(--accent)"}}');
    eq(await nbStatus(i), 'ok', 'status');
    assert(await nbCell(i).locator(NB.rich + ' svg rect').count() === 1, 'svg rect rendered');
    eq(await page.$$eval(NB.cells + ' ' + NB.out + ' script', l => l.length), 0, 'no script in outputs');
  });

  await check(T + 'P10b a text cell renders its markdown when run', async () => {
    await page.click('#nb-end-text');
    const i = (await nbCells()) - 1;
    eq(await nbCell(i).getAttribute('data-type'), 'markdown', 'type');
    await nbSrc(i).fill('# Title\n\nsome *em* and `code`\n\n- one\n- two');
    await nbRun(i);
    await page.waitForFunction(([sel, n]) => !!document.querySelectorAll(sel)[n].querySelector('.nb-md h1'), [NB.cells, i]);
    const r = await nbCell(i).locator('.nb-md').evaluate(e => ({
      h1: e.querySelector('h1').textContent, em: !!e.querySelector('em'), code: !!e.querySelector('code'),
      li: e.querySelectorAll('li').length }));
    eq(r, { h1: 'Title', em: true, code: true, li: 2 }, 'rendered');
  });

  await check(T + 'P10c rich outputs: html, markdown, table, several shows in one cell', async () => {
    let i = await nbEval('notebook.html("<b>bold</b> <i>it</i>")');
    eq(await nbStatus(i), 'ok', 'html status ' + await nbOut(i));
    eq(await nbCell(i).locator(NB.rich + ' b').textContent(), 'bold', 'html');
    i = await nbEval('notebook.markdown("## Head\\n\\n1. a\\n2. b")');
    eq(await nbStatus(i), 'ok', 'markdown status ' + await nbOut(i));
    eq(await nbCell(i).locator(NB.rich + ' h2').textContent(), 'Head', 'markdown h2');
    eq(await nbCell(i).locator(NB.rich + ' ol li').count(), 2, 'markdown list');
    i = await nbEval('notebook.table({{a = 1, b = "x"}, {a = 2, b = "y"}})');
    eq(await nbStatus(i), 'ok', 'table status ' + await nbOut(i));
    eq(await nbCell(i).locator(NB.rich + ' table th').allTextContents(), ['a', 'b'], 'table header');
    eq(await nbCell(i).locator(NB.rich + ' table td').allTextContents(), ['1', 'x', '2', 'y'], 'table cells');
    i = await nbEval('notebook.show(notebook.html("<u>one</u>")) notebook.show(notebook.html("<u>two</u>")) return 3');
    eq(await nbCell(i).locator(NB.rich + ' u').allTextContents(), ['one', 'two'], 'two shows');
    assert(/3/.test(await nbCell(i).locator(NB.value).textContent()), 'and the value');
  });

  await check(T + 'P11 the sanitizer: handlers, scripts, javascript: links; <use> and filter bombs', async () => {
    const i = await nbEval('notebook.html(' + lua('<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">l</a>') + ')');
    eq(await nbStatus(i), 'ok', 'status');
    const r = await nbCell(i).locator(NB.out).evaluate(o => ({
      onerror: o.querySelectorAll('[onerror]').length, script: o.querySelectorAll('script').length,
      js: [...o.querySelectorAll('a')].filter(a => /^\s*javascript:/i.test(a.getAttribute('href') || '')).length,
    }));
    eq(r, { onerror: 0, script: 0, js: 0 }, 'sanitized');
    await page.waitForTimeout(300);
    eq(dialogs, [], 'no alert');
    const b = await page.evaluate(async () => {
      const L = window.LuaNotebookLib;
      const bomb = lv => {
        let s = '<defs><g id="l0"><rect width="1" height="1"/></g>';
        for (let k = 1; k <= lv; k++) s += `<g id="l${k}">` + `<use href="#l${k - 1}"/>`.repeat(10) + '</g>';
        return s + `</defs><use href="#l${lv}"/>`;
      };
      const doc = s => '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">' + s + '</svg>';
      const heavy = '<filter id="f">' +
        '<feGaussianBlur stdDeviation="30"/><feMorphology operator="dilate" radius="40"/>'.repeat(5) + '</filter>' +
        '<rect width="800" height="800" filter="url(#f)"/>'.repeat(20);
      const box = document.createElement('div');
      box.className = 'nb-rich';
      document.body.appendChild(box);
      const t = performance.now();
      box.appendChild(L.sanitizeMarkup(doc(bomb(5)), 'svg', 'pw-use-'));
      box.getBoundingClientRect();
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      const inst = (el, d) => {
        if (d > 32) return Infinity;
        let n = 1;
        const t = el.localName === 'use' && document.getElementById((el.getAttribute('href') || '').slice(1));
        if (t) n += inst(t, d + 1);
        for (const c of el.children) n += inst(c, d);
        return n;
      };
      const use = { ms: Math.round(performance.now() - t), rendered: inst(box, 0) };
      box.textContent = '';
      box.appendChild(L.sanitizeMarkup(doc(heavy), 'svg', 'pw-flt-'));
      const filtered = box.querySelectorAll('[filter]').length;
      box.remove();
      return { use, filtered };
    });
    assert(b.use.ms < 1000 && b.use.rendered < 5000, '<use> bomb bounded: ' + J(b.use));
    eq(b.filtered, 0, 'heavy filters dropped');
  });

  await check(T + 'P12 the highlighter in a code cell', async () => {
    const src = 'local s = [[a]] -- c';
    const i = await nbNew(src);
    await page.waitForTimeout(100);
    const r = await nbCell(i).locator(NB.hl).evaluate(e => ({
      text: e.textContent, kinds: [...e.querySelectorAll('span')].map(s => s.className + ':' + s.textContent),
    }));
    eq(r.text, src, 'the overlay mirrors the source');
    for (const k of ['syn-special:local', 'syn-string:[[a]]', 'syn-comment:-- c'])
      assert(r.kinds.includes(k), k + ' in ' + r.kinds.join(' '));
  });

  await check(T + 'P13 Stop in the notebook with i i: "Interrupted."', async () => {
    const i = await nbNew('while true do end');
    await nbRun(i);
    await nbWait(i, /^running$/);
    await nbSrc(i).press('Escape');
    await page.keyboard.press('i');
    await page.keyboard.press('i');
    await nbWait(i, /^interrupted$/, 5000);
    assert(/Interrupted\./.test(await nbOut(i)), 'note: ' + await nbOut(i));
  });

  await check(T + 'P13b the Stop button; Restart gives a fresh kernel', async () => {
    let i = await nbNew('while true do end');
    await nbRun(i);
    await nbWait(i, /^running$/);
    await page.waitForTimeout(200);
    await page.click(NB.stop);
    await nbWait(i, /^interrupted$/, 5000);
    i = await nbEval('kept = 42 print(kept)');
    assert(/42/.test(await nbOut(i)), 'set: ' + await nbOut(i));
    await page.click(NB.restart);
    await waitNbStatus(/^ready$/, 60000);
    i = await nbEval('print(kept)', 60000);
    eq(await nbStatus(i), 'ok', 'status');
    assert(/(^|\n)nil\n/.test(await nbOut(i)), 'a fresh kernel: ' + J(await nbOut(i)));
  });

  await check(T + 'P13c a traceback link goes to the cell of its own kernel session', async () => {
    const restart = async () => { await page.click(NB.restart); await waitNbStatus(/^ready$/, 60000); };
    await restart();
    const a = await nbEval('function boom() error("x") end\nboom()');        // In[1]
    await restart();                                                      // a is stale now
    const b = await nbEval('local function f()\n  error("y")\nend\nf()');    // In[1] again
    eq(await nbCell(a).locator(NB.count).textContent(), await nbCell(b).locator(NB.count).textContent(), 'the same count');
    await nbCell(b).locator('details.nb-trace summary').click();
    await nbCell(b).locator('button.where', { hasText: 'In[1]:2' }).first().click();
    const at = await page.evaluate(sel => [...document.querySelectorAll(sel)].findIndex(li => li.contains(document.activeElement)), NB.cells);
    eq(at, b, 'the cell focused');
  });

  await check(T + 'P14 the stdin box', async () => {
    const i = await nbNew('print(io.read())');
    await nbRun(i);
    await page.waitForFunction(([sel, n, box]) => {
      const li = document.querySelectorAll(sel)[n];
      const b = li && li.querySelector(box);
      return b && !b.hidden && b.offsetParent !== null;
    }, [NB.cells, i, NB.stdin], { timeout: 10000 });
    await nbCell(i).locator(NB.stdinText).fill('x');
    await nbCell(i).locator(NB.stdinText).press('Enter');
    await nbWait(i);
    eq(await nbStatus(i), 'ok', 'status');
    assert(/(^|\n)x\n/.test(await nbOut(i)), 'printed: ' + J(await nbOut(i)));
  });

  await check(T + 'P21 smart quotes in a notebook cell', async () => {
    const i = await nbEval('print(“hi”)');
    eq(await nbStatus(i), 'ok', 'status ' + await nbOut(i));
    assert(/(^|\n)hi\n/.test(await nbOut(i)), 'printed: ' + J(await nbOut(i)));
  });

  await check(T + 'P15 export .json, New notebook, import it; .lua and .html exports', async () => {
    const cells = () => page.$$eval(NB.cells, (l, s) => l.map(e => [e.dataset.type, e.querySelector(s).value]), NB.src);
    const before = await cells();
    const [dj] = await Promise.all([page.waitForEvent('download'), menu('.json')]);
    const json = fs.readFileSync(await dj.path(), 'utf8');
    eq(JSON.parse(json).format, 'lua-notebook', 'json format');
    await menu('New notebook');
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length !== n, [NB.cells, before.length]);
    await page.setInputFiles(NB.file, { name: 'nb.json', mimeType: 'application/json', buffer: Buffer.from(json) });
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length === n, [NB.cells, before.length]);
    eq(await cells(), before, 'the same cell sources');
    const [dl] = await Promise.all([page.waitForEvent('download'), menu('.lua')]);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    assert(/^-- %%$/m.test(text) && /^-- %% \[markdown\]$/m.test(text), '.lua markers: ' + text.slice(0, 300));
    const [dh] = await Promise.all([page.waitForEvent('download'), menu('.html')]);
    const h = fs.readFileSync(await dh.path(), 'utf8');
    const parsed = await page.evaluate(src => {
      const d = new DOMParser().parseFromString(src, 'text/html');
      const csp = d.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return { scripts: d.querySelectorAll('script').length, csp: csp && csp.getAttribute('content'),
               handlers: [...d.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length };
    }, h);
    eq(parsed.scripts, 0, 'no script in the .html export');
    eq(parsed.handlers, 0, 'no handler in the .html export');
    assert(parsed.csp && /default-src 'none'/.test(parsed.csp), 'the CSP meta: ' + parsed.csp);
  });

  await check(T + 'P16 a reload restores the cells, with the outputs marked stale', async () => {
    const i = await nbEval('"persist me"');
    await page.keyboard.press('Control+s');
    const n = await nbCells();
    await page.reload();
    await waitPill('ready', 60000);
    await page.click('#tab-notebook');
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length === n, [NB.cells, n]);
    const k = await page.$$eval(NB.cells, (l, s) => l.findIndex(e => /persist me/.test(e.querySelector(s).value)), NB.src);
    eq(k, i, 'restored at');
    eq(await nbCell(k).getAttribute('data-stale'), 'true', 'stale');
    assert(/persist me/.test(await nbOut(k)), 'output kept: ' + await nbOut(k));
  });

  await check(T + 'P16b an unreadable save is kept aside, not overwritten by the autosave', async () => {
    const work = { format: 'lua-notebook', version: 2, cells: [{ type: 'code', source: 'my precious work' }] };
    await page.evaluate(w => localStorage.setItem('lua-web.notebook', JSON.stringify(w)), work);
    await page.reload();
    await waitPill('ready', 60000);
    await page.click('#tab-notebook');
    await page.waitForFunction(sel => /could not be read/.test(document.querySelector(sel).textContent), NB.noticeText);
    const kept = () => page.evaluate(() => localStorage.getItem('lua-web.notebook.unreadable'));
    eq(JSON.parse(await kept()).cells[0].source, 'my precious work', 'copied aside');
    await nbNew('-- an edit');
    await page.waitForTimeout(1200);      // past the autosave
    eq(JSON.parse(await page.evaluate(() => localStorage.getItem('lua-web.notebook'))).version, 1, 'autosaved');
    eq(JSON.parse(await kept()).cells[0].source, 'my precious work', 'still kept');
    await page.evaluate(() => localStorage.removeItem('lua-web.notebook.unreadable'));
  });

  await check(T + 'P18 the shortcuts dialog fits at 320 px; the notebook does not scroll sideways at 360 px', async () => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(200);
    const p = await page.$eval(NB.panel, e => [e.scrollWidth, e.clientWidth]);
    const d = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    await page.setViewportSize({ width: 320, height: 740 });
    await nbCell(0).focus();
    await page.keyboard.press('?');
    await page.waitForSelector(NB.shortcuts + '[open]');
    const w = await page.$eval(NB.shortcuts, e => [e.scrollWidth, e.clientWidth]);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
    assert(p[0] <= p[1] && d[0] <= d[1], 'no horizontal scroll at 360 px: ' + J({ panel: p, doc: d }));
    assert(w[0] <= w[1], 'the shortcuts dialog fits: ' + w);
  });

  if (shots) {
    await page.mouse.move(0, 0);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, `${shotName}-notebook-${scheme}-desktop.png`) });
      await page.setViewportSize({ width: 360, height: 740 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(shots, `${shotName}-notebook-${scheme}-360.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  await page.click('#tab-console');

  // P8 reloads this page into the other build, whose own warnings are not the wasm64 page's
  let legacyEhBeforeSwitch = null;
  if (target.switchTo) await check(T + `P8 Settings > Build > ${target.switchTo} reloads into that build`, async () => {
    legacyEhBeforeSwitch = legacyEh.length;
    const nav = page.waitForEvent('load', { timeout: 60000 });
    await settings(() => page.check(`input[name="arch"][value="${target.switchTo}"]`));
    await nav;
    await waitPill('ready', 60000);
    eq((await page.textContent('#arch')).trim(), target.switchTo, 'the header chip');
    await evalTo('string.packsize("T")', target.switchTo === 'wasm32' ? /\n4\n/ : /\n8\n/);
    await settings(() => page.check('#set-arch-auto'));
    await page.waitForEvent('load', { timeout: 60000 }).catch(() => {});
    await waitPill('ready', 60000);
  });

  await check(T + 'P17 offline: no request outside the origin; every script, style and module carries ?v=', async () => {
    const outside = requests.filter(u => !u.startsWith(base) && !/^(data|blob):/.test(u));
    eq(outside, [], 'requests outside the origin');
    const unversioned = requests.filter(u => u.startsWith(base) && /\.(js|wasm|css)(\?|$)/.test(new URL(u).pathname + '?') &&
                                        !new URL(u).searchParams.has('v'));
    eq(unversioned, [], 'requests without ?v=');
  });

  await check(T + 'P1 no console errors' + (target.arch === 'wasm64' ? ', no legacy exception handling warning' : ''), async () => {
    assert(!errors.length, errors.join('\n'));
    const n = legacyEhBeforeSwitch == null ? legacyEh.length : legacyEhBeforeSwitch;
    if (target.arch === 'wasm64') assert(!n, 'legacy EH warnings on a wasm64 page: ' + n);
    else if (legacyEh.length) console.log('  # ' + legacyEh.length + ' legacy exception handling warnings (wasm32)');
  });
  await context.close();
}

for (const bname of browsers) {
  let browser;
  try { browser = await pw[bname].launch(); }
  catch (e) { failures++; console.log('not ok - ' + bname + ': cannot launch: ' + String(e.message || e).split('\n')[0]); continue; }
  const probe = await browser.newPage();
  const mem64 = await engineHasMemory64(probe);
  await probe.close();
  console.log('# ' + bname + ' ' + browser.version() + (mem64 ? '' : ' (no memory64)'));
  const targets = [];
  if (process.env.QUERIES) {
    for (const q of process.env.QUERIES.split(',').map(s => s.trim()).filter(Boolean)) {
      const arch = new URLSearchParams(q).get('arch');
      if (arch === 'wasm64' && !mem64) { console.log('# skipping ' + q + ': no memory64 in ' + bname); continue; }
      targets.push({ query: q, arch, note: null });
    }
  } else if (mem64 && builds.some(b => b.arch === 'wasm64')) {
    targets.push({ query: '', arch: 'wasm64', note: null, switchTo: has32 ? 'wasm32' : null });
    if (has32) targets.push({ query: '?arch=wasm32', arch: 'wasm32', note: null });
  } else if (has32) {
    targets.push({ query: '', arch: 'wasm32', note: builds[0].arch === 'wasm32' ? null : /-- running the wasm32 build/ });
  } else {
    failures++;
    console.log('not ok - ' + bname + ': no build of this page runs here');
  }
  for (const t of targets) await runTarget(browser, bname, t);
  await browser.close();
}
if (server.listening) server.close();
console.log(`# ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

function eq(a, b, what) { assert(J(a) === J(b), what + ': expected ' + J(b) + ', got ' + J(a)); }

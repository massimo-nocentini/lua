/* repl.js - the Lua console page (index.html)
 *
 * Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
 */

/* The page side of the console (index.html): owns the console's worker
 * (repl-worker.js, see there for the message protocol), renders output,
 * and handles input, history, Stop, uploads, the Settings, the tabs and
 * the choice of build.  No dependencies; notebook-lib.js, when loaded,
 * colours the echoed input.
 *
 * - The console is webrepl-main.c's port of lua.c's REPL.  Its prompts
 *   come on fd 4 and every state message says whether it waits at a
 *   prompt (1 "> ", 2 ">> ") or for io.read (0), so the status pill and
 *   Ctrl+D know without looking at the text.  Lines already queued get
 *   no prompt: a pasted block runs line by line, as lua.c's does from a
 *   pipe.
 * - The .wasm is compiled once here and handed to every worker (the
 *   notebook's too, through LuaPage.replModule), so Restart only
 *   instantiates.
 * - Output is buffered and rendered once per animation frame, then acked
 *   to the worker (which pauses Lua above 1 MB unacked).
 * - Stop always posts "interrupt".  If the worker then stays silent for
 *   3 s (code inside a C call that cannot be interrupted, such as a huge
 *   string.rep or a table.sort comparator that never returns), it is
 *   terminated and a fresh one started.
 * - Settings, history, the tab and the theme live in localStorage when
 *   available; everything works without it (a build chosen in the
 *   Settings then goes in ?arch=).
 * - A page may have the modules of two architectures (make -C emscripten
 *   WASM_WEB_ARCHS="wasm64 wasm32"): it runs the first one this browser
 *   supports (or the one ?arch= or the Settings ask for), and every
 *   worker loads that one's modules (see "the build" below).
 * - window.LuaPage gives the Notebook tab (notebook.js) the settings, the
 *   storage, the compiled .wasm and the uploads; the page sends it
 *   "lua:tab" and "lua:settings" events.  They are dispatched on the
 *   document and bubble, so listeners on window and on document both get
 *   them. */

(function () {
  'use strict';

  const RUNNING = 0, WAITING = 1, BUSY = 2, EXITED = 3, SLEEPING = 4;
  const TERM_LINES = 20000;             // terminal scrollback cap,
  const TERM_CHARS = 2000000;           // also for output without newlines
  const HISTORY_MAX = 500;
  const WATCHDOG_MS = 3000;
  const HOME = '/home/web_user/';

  const meta = name => (document.querySelector('meta[name="' + name + '"]') || {}).content || '';
  const BUILD = meta('lua-build');
  const Q = BUILD && BUILD.indexOf('@') < 0 ? '?v=' + encodeURIComponent(BUILD) : '';
  const VERSION = /^\d+\.\d+(\.\d+)?$/.test(meta('lua-version')) ? meta('lua-version') : '5.5';
  const $ = id => document.getElementById(id);
  const term = $('term'), line = $('line'), statusPill = $('status'), statusText = $('status-text');
  $('brand-version').textContent = VERSION;

  // ---- storage (may be unavailable: private mode, blocked site data)

  const PREFIX = 'lua-web.';
  const store = {
    // whether settings persist (not with blocked site data, say)
    works: (() => {
      try { localStorage.setItem(PREFIX + '?', '1'); localStorage.removeItem(PREFIX + '?'); return true; }
      catch (e) { return false; }
    })(),
    get(k, d) {
      try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : v; }
      catch (e) { return d; }
    },
    set(k, v) {                         // whether it was stored
      try { localStorage.setItem(PREFIX + k, v); return true; } catch (e) { return false; }
    },
  };
  const touch = matchMedia('(pointer: coarse)').matches;
  const clampSlice = v => Math.max(5, Math.min(1000, Math.round(Number(v)) || 50));
  const settings = {
    init: store.get('init', ''),        // LUA_INIT: Lua code or @file
    args: store.get('args', ''),        // lua options, split by splitArgs
    sliceMs: clampSlice(store.get('sliceMs', '50')),
    quotes: store.get('quotes', touch ? '1' : '0') === '1',
    theme: store.get('theme', 'auto'),
    arch: store.get('arch', 'auto'),    // the build to run, when the page has several
  };

  function applyTheme() {
    if (settings.theme === 'light' || settings.theme === 'dark')
      document.documentElement.dataset.theme = settings.theme;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme();

  // The Arguments setting as a list: words split at white space, where
  // '…' and "…" quote (white space included) and join the word they
  // touch, as in a shell, but with no escapes: -e 'print("a b")' works.
  // An unterminated quote runs to the end.
  function splitArgs(s) {
    const out = [];
    let cur = null, quote = null;
    for (const c of String(s)) {
      if (quote) {
        if (c === quote) quote = null; else cur += c;
      } else if (c === '"' || c === "'") {
        quote = c;
        if (cur === null) cur = '';
      } else if (/\s/.test(c)) {
        if (cur !== null) { out.push(cur); cur = null; }
      } else cur = (cur === null ? '' : cur) + c;
    }
    if (cur !== null) out.push(cur);
    return out;
  }

  // ---- the build

  // The builds of the page (make -C emscripten WASM_WEB_ARCHS=...),
  // "ARCH:EH" each in the lua-wasm-builds meta tag: the first one's
  // modules are beside the page, another's in a directory named after
  // its architecture.  EH is how setjmp/longjmp were built (WASM_SJLJ_*):
  // exnref, legacy or none.  A page without the tag has the one build of
  // the lua-wasm-arch and lua-wasm-eh tags.
  const BUILDS = (() => {
    const l = [], words = meta('lua-wasm-builds').split(/\s+/).filter(w => w && w.indexOf('@') < 0);
    words.forEach((w, i) => {
      const [arch, eh] = w.split(':');
      if (/^wasm(32|64)$/.test(arch) && /^(exnref|legacy|none)$/.test(eh) && !l.some(b => b.arch === arch))
        l.push({ arch, eh, dir: i ? arch + '/' : '' });
    });
    return l.length ? l : [{ arch: meta('lua-wasm-arch'), eh: meta('lua-wasm-eh'), dir: '' }];
  })();
  const PREFER = ['wasm64', 'wasm32'];     // the order of the automatic choice

  // A wasm64 build needs memory64 in the engine, and one made with
  // WASM_SJLJ_*=wasm (the default on wasm64) or wasm-legacy (the default
  // on wasm32) the exception handling instructions it uses: without them
  // the modules fail to compile.  Each probe module has just the
  // feature: a 64-bit memory, an empty try_table (exnref), an empty
  // legacy try.  A feature is probed only when a build that needs it is
  // considered: Firefox may warn about a module with the deprecated try,
  // even a probe.
  const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];   // magic, version
  const FUNC = [0x01, 0x04, 0x01, 0x60, 0x00, 0x00,                  // type: [] -> []
                0x03, 0x02, 0x01, 0x00];                             // one function
  const PROBES = {
    memory64: [...HEADER, 0x05, 0x03, 0x01, 0x04, 0x00],             // memory: i64, min 0
    exnref: [...HEADER, ...FUNC, 0x0a, 0x08, 0x01, 0x06, 0x00, 0x1f, 0x40, 0x00, 0x0b, 0x0b],  // try_table end end
    legacy: [...HEADER, ...FUNC, 0x0a, 0x07, 0x01, 0x05, 0x00, 0x06, 0x40, 0x0b, 0x0b],        // try end end
  };
  const FEATURES = {
    memory64: '64-bit WebAssembly (memory64)',
    exnref: 'WebAssembly exception handling with exnref',
    legacy: 'WebAssembly exception handling (the legacy instructions)',
  };
  const probed = {};
  function has(f) {
    if (!(f in probed)) {
      try { probed[f] = WebAssembly.validate(new Uint8Array(PROBES[f])); }
      catch (e) { probed[f] = false; }
    }
    return probed[f];
  }
  const needs = b => [...(b.arch === 'wasm64' ? ['memory64'] : []), ...(b.eh in PROBES ? [b.eh] : [])];
  const lacks = b => needs(b).filter(f => !has(f));
  // the same, but without a probe for legacy that has not been made
  const lacksKnown = b => needs(b).filter(f => (f !== 'legacy' || f in probed) && !has(f));
  const featureList = l => l.map(f => FEATURES[f]).join(' and ');

  // the browsers that run a build (see deploy/README.txt)
  function browsersFor(b) {
    if (b.arch === 'wasm64') return 'Chrome or Edge ' + (b.eh === 'exnref' ? 137 : 133) + ', Firefox 134 or later';
    if (b.eh === 'exnref') return 'Chrome or Edge 137, Firefox 131, Safari 18.4 or later';
    return 'Chrome or Edge 95, Firefox 100, Safari 15.4 or later';
  }
  // why this browser cannot run the page's only build b, and what to do
  function missingFeature(b, miss) {
    const exnref = b.eh === 'exnref';
    if (miss.includes('memory64'))
      return '-- this browser does not support 64-bit WebAssembly (memory64), which this build needs.\n' +
        '-- Use Chrome or Edge ' + (exnref ? 137 : 133) + ', Firefox 134 or later, or a build made with ' +
        '"make -C emscripten WASM_WEB_ARCHS=wasm32".';
    if (miss.includes('exnref'))
      return '-- this browser does not support WebAssembly exception handling with exnref, which this build needs.\n' +
        '-- Use ' + (b.arch === 'wasm64' ? 'Chrome or Edge 137, Firefox 134' : 'Chrome or Edge 137, Firefox 131, Safari 18.4') +
        ' or later, or a build made with "make -C emscripten WASM_SJLJ_' + b.arch + '=wasm-legacy".';
    return '-- this browser does not support WebAssembly exception handling, which this build needs.\n' +
      '-- Use ' + browsersFor(b) + ', or a build made with "make -C emscripten WASM_SJLJ_' + b.arch + '=emscripten".';
  }

  // The build to run: the one ?arch= in the URL asks for, else the one
  // chosen in the Settings (on a page with several builds), if this
  // browser can run it; else, as with "auto" for either, the first in
  // PREFER order it can run.  Returns {build, notes, missing}: build is
  // null when it can run none (missing then says why), notes explain
  // the choice.
  function choose(urlArch, setArch) {
    const inUrl = urlArch != null && urlArch !== '';
    const want = inUrl ? (urlArch === 'auto' ? null : urlArch)
      : BUILDS.length > 1 && setArch !== 'auto' ? setArch : null;
    const how = inUrl ? '?arch=' + urlArch.slice(0, 40) : 'the build chosen in the Settings';
    const notes = [];
    let build = null, refused = null;
    if (want != null) {
      const b = BUILDS.find(x => x.arch === want);
      if (!b)
        notes.push('-- ignoring ' + how + ': this page has ' +
                   (BUILDS.length > 1 ? 'the ' + BUILDS.map(x => x.arch).join(' and ') + ' builds.'
                    : 'only the ' + BUILDS[0].arch + ' build.'));
      else if (lacks(b).length) {
        notes.push('-- ignoring ' + how + ': this browser lacks ' + featureList(lacks(b)) +
                   ', which the ' + b.arch + ' build needs.');
        refused = b;
      } else {
        build = b;
        if (BUILDS.length > 1) notes.push('-- running the ' + b.arch + ' build, as ' + how + ' asks.');
      }
    }
    if (build) return { build, notes, missing: null };
    const fails = [];
    for (const b of BUILDS.slice().sort((x, y) => PREFER.indexOf(x.arch) - PREFER.indexOf(y.arch))) {
      const miss = lacks(b);
      if (!miss.length) { build = b; break; }
      fails.push({ b, miss });
    }
    if (build && fails.length)
      notes.push(fails[0].b === refused ? '-- running the ' + build.arch + ' build instead.'
                 : '-- running the ' + build.arch + ' build: this browser lacks ' + featureList(fails[0].miss) +
                   ', which the ' + fails[0].b.arch + ' build needs.');
    if (build) return { build, notes, missing: null };
    return {
      build: null, notes,
      missing: BUILDS.length === 1 ? missingFeature(fails[0].b, fails[0].miss)
        : '-- this browser runs no build of this page: ' +
          fails.map(({ b, miss }) => b.arch + ' needs ' + featureList(miss)).join('; ') + '.\n' +
          '-- Use ' + browsersFor(fails[fails.length - 1].b) + '.',
    };
  }

  let urlArch = null;
  try { urlArch = new URLSearchParams(location.search).get('arch'); } catch (e) { urlArch = null; }
  const CHOICE = choose(urlArch, settings.arch);
  // Without storage the choice in the Settings is the one ?arch= makes
  // (a choice there loads the page again with it).
  if (!store.works && BUILDS.length > 1 && (urlArch === 'auto' || BUILDS.some(b => b.arch === urlArch)))
    settings.arch = urlArch;
  const HTTP_HINT = 'This page must be served over HTTP, for example with "make -C emscripten serve" ' +
    'or "python3 serve.py" in the bundle.';
  // why nothing can run here, or null
  const LOCKOUT = location.protocol === 'file:'
    ? '-- ' + HTTP_HINT + '\n-- Browsers do not run workers or fetch .wasm files from file:// URLs.'
    : typeof WebAssembly !== 'object' || typeof Worker !== 'function'
    ? '-- this browser lacks WebAssembly or Web Workers.'
    : CHOICE.missing;
  // the build that runs; when none does, what a page with one build was
  // built for, and nothing on a page with several
  const RUNS = LOCKOUT ? (BUILDS.length > 1 ? null : BUILDS[0]) : CHOICE.build;
  const ARCH = RUNS ? RUNS.arch : '', EH = RUNS ? RUNS.eh : '';
  const DIR = CHOICE.build ? CHOICE.build.dir : '';
  // the workers get the build id and the directory of the modules
  const WQ = (() => {
    const p = new URLSearchParams();
    if (Q) p.set('v', BUILD);
    if (DIR) p.set('dir', DIR);
    const t = p.toString();
    return t ? '?' + t : '';
  })();
  const workerUrl = name => name + WQ;
  if (BUILDS.length > 1) {
    // the build in the header, and its choice in the Settings
    if (!LOCKOUT) {
      const chip = $('arch');
      chip.textContent = ARCH;
      chip.title = 'Running the ' + ARCH + ' build (' + (ARCH === 'wasm64' ? '64' : '32') +
        '-bit WebAssembly); this page has ' + BUILDS.map(b => b.arch).join(' and ') + '. Choose one in the Settings.';
      chip.hidden = false;
    }
    for (const r of document.querySelectorAll('input[name="arch"]'))
      r.parentNode.hidden = r.value !== 'auto' && !BUILDS.some(b => b.arch === r.value);
    archSetting();
    $('set-arch').hidden = false;
  }
  // The builds in the Settings: one this browser is known not to run
  // (probed, see lacksKnown) cannot be chosen.
  function archSetting() {
    if (BUILDS.length < 2) return;
    const cannot = [];
    for (const r of document.querySelectorAll('input[name="arch"]')) {
      const b = BUILDS.find(x => x.arch === r.value), miss = b ? lacksKnown(b) : [];
      r.disabled = miss.length > 0;
      if (miss.length) cannot.push('This browser cannot run ' + b.arch + ': it lacks ' + featureList(miss) + '.');
    }
    $('set-arch-help').textContent =
      'wasm64 needs memory64; wasm32 runs everywhere and is about 1.5x faster. ' +
      (LOCKOUT ? '' : 'Running ' + ARCH + '. ') +
      'Automatic runs ' + PREFER.filter(a => BUILDS.some(b => b.arch === a)).join(' where the browser supports it, else ') +
      '; ?arch= in the URL overrides this. Choosing another build than the one running reloads the page' +
      (store.works ? '.' : ' with ?arch=, as this browser keeps no settings.') +
      (cannot.length ? ' ' + cannot.join(' ') : '');
  }

  // ---- terminal output

  let pending = [];                     // [{cls, text}] not yet rendered
  let ackChars = 0;                     // worker output rendered, not yet acked
  let rendering = 0;
  let lines = 0, chars = 0;
  let lastCls = null, lastPrompt = '';  // what was emitted last; the prompt text, when it was one

  function countLines(s) {
    let n = 0;
    for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
    return n;
  }

  // cls: 'out' (stdout), 'err' (stderr), 'p' (the prompt, fd 4), 'in'
  // (echoed input), 'sys' (page notes)
  function emit(cls, text, fromWorker) {
    if (!text) return;
    if (cls === 'p') lastPrompt = lastCls === 'p' ? lastPrompt + text : text;
    lastCls = cls;
    const last = pending[pending.length - 1];
    if (last && last.cls === cls) {
      last.text += text;
      // what render() would trim at once (pieces of a large write come
      // in many messages a frame)
      if (last.text.length > TERM_CHARS) last.text = last.text.slice(-TERM_CHARS);
    } else pending.push({ cls, text });
    if (fromWorker) ackChars += text.length;
    if (!rendering) rendering = requestAnimationFrame(render);
  }
  // A page message on a line of its own.  At a prompt the prompt is
  // written again after it, so the next echoed line still follows one.
  function note(text) {
    const reprompt = lastCls === 'p' && atPrompt() ? lastPrompt : '';
    const lastText = pending.length ? pending[pending.length - 1].text
      : term.querySelector('.loading') ? '' : term.textContent;
    emit('sys', (lastText && !lastText.endsWith('\n') ? '\n' : '') + text + '\n');
    if (reprompt) emit('p', reprompt);
  }

  // The echoed input, coloured by notebook-lib.js's highlighter when it
  // is loaded (it is not needed: plain text otherwise).
  const SYN = new Set(['comment', 'string', 'number', 'special', 'constant', 'keyword', 'quote', 'paren']);
  function inNode(text) {
    const span = document.createElement('span');
    span.className = 'in';
    const L = window.LuaNotebookLib;
    let pieces = null;
    if (L && typeof L.highlight === 'function' && text.length <= 200000) {
      try {
        pieces = L.highlight(text);
        if (!Array.isArray(pieces) || pieces.map(p => p[1]).join('') !== text) pieces = null;
      } catch (e) { pieces = null; }
    }
    if (!pieces) { span.textContent = text; return span; }
    for (const [kind, t] of pieces) {
      if (!t) continue;
      if (SYN.has(kind)) {
        const s = document.createElement('span');
        s.className = 'syn-' + kind;
        s.textContent = t;
        span.appendChild(s);
      } else span.appendChild(document.createTextNode(t));
    }
    return span;
  }

  function render() {
    rendering = 0;
    if (!pending.length && !ackChars) return;
    const loading = term.querySelector('.loading');
    if (loading) loading.remove();
    const stick = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const { cls, text } of pending) {
      let node;
      if (cls === 'in') node = inNode(text);
      else if (cls === 'out') node = document.createTextNode(text);
      else {
        node = document.createElement('span');
        node.className = cls;
        node.textContent = text;
      }
      node._lines = countLines(text);
      node._chars = text.length;
      lines += node._lines;
      chars += text.length;
      frag.appendChild(node);
    }
    pending = [];
    term.appendChild(frag);
    trim();
    if (stick) term.scrollTop = term.scrollHeight;
    if (ackChars && worker) {
      worker.postMessage({ type: 'ack', bytes: ackChars });
    }
    ackChars = 0;
  }

  function trim() {
    let excess = lines - TERM_LINES;
    while (excess > 0 && term.firstChild) {
      const n = term.firstChild, nl = n._lines || 0;
      if (nl <= excess) {
        term.removeChild(n);
        lines -= nl;
        chars -= n._chars || 0;
        excess -= nl;
        continue;
      }
      const t = n.textContent;
      let i = -1;
      for (let k = 0; k < excess; k++) i = t.indexOf('\n', i + 1);
      n.textContent = t.slice(i + 1);
      n._lines -= excess;
      lines -= excess;
      chars -= i + 1;
      n._chars -= i + 1;
      excess = 0;
    }
    let cexcess = chars - TERM_CHARS;
    while (cexcess > 0 && term.firstChild) {
      const n = term.firstChild, nc = n._chars || 0, nl = n._lines || 0;
      if (nc <= cexcess) {
        term.removeChild(n);
        chars -= nc;
        lines -= nl;
        cexcess -= nc;
        continue;
      }
      const t = n.textContent.slice(cexcess);
      n.textContent = t;
      n._chars = t.length;
      n._lines = countLines(t);
      lines -= nl - n._lines;
      chars -= cexcess;
      cexcess = 0;
    }
  }

  function clearTerm() {
    pending = [];
    term.textContent = '';
    lines = chars = 0;
    lastCls = null;
    if (worker && ackChars) worker.postMessage({ type: 'ack', bytes: ackChars });
    ackChars = 0;
  }

  // ---- status

  let worker = null, gen = 0, ready = false, alive = false, state = null, prompt = 0;
  let msgs = 0, watchdog = 0, eofSent = false;   // msgs: messages from the worker
  const reqs = new Map();
  let reqId = 0;

  // whether the REPL waits at "> " or ">> " (not for io.read)
  const atPrompt = () => state === WAITING && prompt > 0;

  function setStatus(key, text) {
    statusPill.dataset.state = key;
    if (statusText.textContent !== (text || key)) statusText.textContent = text || key;
  }
  function updateStatus() {
    if (!alive) return;
    if (!ready) return setStatus('loading');
    switch (state) {
    case WAITING:
      return prompt === 1 ? setStatus('ready')
        : prompt === 2 ? setStatus('continue', 'statement continues')
        : setStatus('waiting', 'waiting for input');
    case RUNNING:
    case BUSY:     return setStatus('running');
    case SLEEPING: return setStatus('sleeping');
    default:       return setStatus('loading');
    }
  }
  function setInputEnabled(on) {
    line.disabled = !on;
    $('send').disabled = !on;
    $('stop').disabled = !on;
  }
  function showNotice(text) {
    $('notice-text').textContent = text;
    $('notice').hidden = false;
  }
  function hideNotice() { $('notice').hidden = true; }

  // ---- the console's worker

  let replModuleP = null;
  function compileWasm(url) {
    return (async () => {
      if (WebAssembly.compileStreaming) {
        try { return await WebAssembly.compileStreaming(fetch(url)); }
        catch (e) { /* no application/wasm type: fall back */ }
      }
      const r = await fetch(url);
      if (!r.ok) throw new Error('cannot fetch ' + url + ' (HTTP ' + r.status + ')');
      return WebAssembly.compile(await r.arrayBuffer());
    })();
  }
  const WASM = DIR + 'lua-repl.wasm';
  function replModule() {               // of the build chosen, compiled once
    if (!replModuleP) {
      const p = compileWasm(WASM + Q);
      replModuleP = p;
      p.catch(() => { if (replModuleP === p) replModuleP = null; });
    }
    return replModuleP;
  }

  const uploads = new Map();            // name -> Uint8Array, resent on every spawn
  let unavailable = null;               // why nothing can run (set at start), or null
  let unavailableDetail = null;         // the same with what to do about it

  function kill() {
    gen++;
    clearTimeout(watchdog);
    if (worker) worker.terminate();
    worker = null;
    alive = ready = false;
    state = null;
    prompt = 0;
    for (const r of reqs.values()) {
      const e = new Error('the interpreter was restarted');
      e.restarted = true;               // (an upload is then written by the next spawn)
      r.reject(e);
    }
    reqs.clear();
    ackChars = 0;
  }

  function fatal(msg) {
    kill();
    setStatus('error', 'unavailable');
    setInputEnabled(false);
    note(msg);
    showNotice(msg.split('\n')[0].replace(/^-- /, ''));
  }

  async function spawn() {
    if (unavailable) return;
    kill();
    const g = gen;
    alive = true;
    eofSent = false;
    hideNotice();
    setInputEnabled(false);
    setStatus('loading');
    let mod;
    try {
      mod = await replModule();
    } catch (e) {
      if (g === gen) fatal('-- could not load ' + WASM + ': ' + ((e && e.message) || e) + '\n-- ' + HTTP_HINT);
      return;
    }
    if (g !== gen) return;
    let w;
    try { w = new Worker(workerUrl('repl-worker.js')); }
    catch (e) { fatal('-- could not start the worker: ' + ((e && e.message) || e) + '\n-- ' + HTTP_HINT); return; }
    worker = w;
    w.onmessage = e => { if (g === gen) onWorker(e.data); };
    w.onerror = e => {
      if (g !== gen) return;
      e.preventDefault();
      fatal('-- the interpreter worker failed: ' + ((e && e.message) || 'could not load repl-worker.js') + '\n-- ' + HTTP_HINT);
    };
    w.onmessageerror = () => { if (g === gen) fatal('-- a message from the interpreter could not be decoded'); };
    w.postMessage({
      type: 'init',
      args: splitArgs(settings.args),
      init: settings.init.trim() ? settings.init : null,
      files: [...uploads].map(([name, data]) => ({ path: HOME + name, data })),
      sliceMs: settings.sliceMs,
      wasmModule: mod,
    });
  }

  function finished(text, notice) {
    render();
    kill();
    setStatus('exited');
    setInputEnabled(false);
    note(text);
    showNotice(notice);
  }

  let choiceNoted = false;
  function onWorker(m) {
    msgs++;
    switch (m.type) {
    case 'ready':
      ready = true;
      if (!choiceNoted) {               // before the banner
        choiceNoted = true;
        if (CHOICE.notes.length && term.querySelector('.loading')) term.querySelector('.loading').remove();
        for (const t of CHOICE.notes) note(t);
      }
      setInputEnabled(true);
      if (!touch && !document.querySelector('dialog[open]') && !$('panel-console').hidden) line.focus();
      updateStatus();
      break;
    case 'output':
      // fd 3 (kernel events) never comes from the console
      if (m.fd === 1 || m.fd === 2 || m.fd === 4) emit(m.fd === 1 ? 'out' : m.fd === 2 ? 'err' : 'p', m.text, true);
      else worker.postMessage({ type: 'ack', bytes: m.text.length });
      break;
    case 'state':
      state = m.state;
      prompt = m.prompt || 0;
      updateStatus();
      break;
    case 'exit':
      if (eofSent && m.code === 0) finished('-- session ended', 'The session ended.');
      else finished('-- process exited (code ' + m.code + ')', 'Lua exited with code ' + m.code + '.');
      break;
    case 'crash':
      emit('err', String(m.message).replace(/\n?$/, '\n'));
      finished('-- the interpreter crashed', 'The interpreter crashed.');
      break;
    case 'ack': case 'file': case 'dir': case 'error': {
      const r = reqs.get(m.id);
      if (!r) break;
      reqs.delete(m.id);
      if (m.type === 'error') r.reject(new Error(m.message)); else r.resolve(m);
      break;
    }
    }
  }

  function request(msg) {
    return new Promise((resolve, reject) => {
      if (!worker) { reject(new Error('the interpreter is not running')); return; }
      const id = ++reqId;
      reqs.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id }, msg));
    });
  }

  // ---- Stop, Restart, EOF

  function stop() {
    if (!worker || !alive) return;
    worker.postMessage({ type: 'interrupt' });
    if (state === WAITING) { line.value = ''; autosize(); }
    // The interrupt makes the worker report at once, whatever state it
    // was last in: a slice that woke from a sleep or got its input may
    // have run into a long C call since, without reporting.  (Counted,
    // not timed: the reply may come within the clock's resolution, which
    // is 1 ms or coarser in some browsers.)
    const g = gen, n0 = msgs;
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (g !== gen || msgs !== n0) return;
      note('-- interpreter restarted (state lost)');
      spawn();
    }, WATCHDOG_MS);
  }

  function restart() {
    if (unavailable) return;            // also from Settings
    render();
    kill();                             // first: note() must not repeat the old prompt
    if (term.textContent) note('-- restarting…');
    spawn();
  }

  function sendEof() {
    if (!worker || !alive) return;
    if (atPrompt() && !confirm('End the Lua session?')) return;
    // only an EOF at a prompt ends the session: one that answers an
    // io.read ends that read only, and the REPL goes on
    eofSent = atPrompt();
    worker.postMessage({ type: 'input', text: '', eof: true });
  }

  // ---- input and history

  let history = [];
  try { history = JSON.parse(store.get('history', '[]')); } catch (e) { history = []; }
  if (!Array.isArray(history)) history = [];
  history = history.filter(h => typeof h === 'string' && h.trim()).slice(-HISTORY_MAX);
  let histIdx = history.length, draft = '';

  function autosize() {
    line.style.height = 'auto';
    line.style.height = line.scrollHeight + 'px';
  }

  // Lua-aware (strings, long brackets and comments), in notebook-lib.js
  const straightenQuotes = s => (window.LuaNotebookLib && typeof LuaNotebookLib.straightenQuotes === 'function'
                                 ? LuaNotebookLib.straightenQuotes(s) : s);

  function submit() {
    if (!worker || !alive || !ready) return;
    let text = line.value;
    if (settings.quotes) text = straightenQuotes(text);
    if (text.trim() && history[history.length - 1] !== text) {
      history.push(text);
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      store.set('history', JSON.stringify(history));
    }
    histIdx = history.length;
    draft = '';
    emit('in', text + '\n');
    render();
    term.scrollTop = term.scrollHeight;
    // a multi-line text is sent whole: the REPL takes it line by line
    worker.postMessage({ type: 'input', text: text + '\n', eof: false });
    line.value = '';
    autosize();
    // Lua runs until the worker reports otherwise, which may be never:
    // a long C call does not yield (and then Stop needs the watchdog)
    state = RUNNING;
    prompt = 0;
    updateStatus();
  }

  function recall(dir) {
    if (!history.length) return;
    if (histIdx === history.length) draft = line.value;
    histIdx = Math.max(0, Math.min(history.length, histIdx + dir));
    line.value = histIdx === history.length ? draft : history[histIdx];
    autosize();
    const end = line.value.length;
    line.setSelectionRange(end, end);
  }

  line.addEventListener('input', autosize);
  line.addEventListener('keydown', e => {
    const v = line.value, a = line.selectionStart, b = line.selectionEnd;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && v) {
      e.preventDefault();                 // on an empty line Tab moves focus as usual
      line.setRangeText('  ', a, b, 'end');
      autosize();
    } else if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && a === b && v.lastIndexOf('\n', a - 1) < 0) {
      e.preventDefault();
      recall(-1);
    } else if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && a === b && v.indexOf('\n', a) < 0) {
      e.preventDefault();
      recall(1);
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd' && !v) {
      e.preventDefault();
      sendEof();
    }
  });

  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]') || $('panel-console').hidden) return;
    const k = (e.key || '').toLowerCase();
    if (e.key === 'Escape') { e.preventDefault(); stop(); }
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && k === 'c') {
      // Ctrl+C copies when something is selected, else it stops
      const sel = getSelection();
      if ((sel && !sel.isCollapsed) || line.selectionStart !== line.selectionEnd) return;
      e.preventDefault();
      stop();
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && k === 'l') {
      e.preventDefault();
      clearTerm();
    }
  });

  // Clicking the terminal (without selecting) focuses the input line.
  term.addEventListener('mouseup', () => {
    const sel = getSelection();
    if ((!sel || sel.isCollapsed) && !line.disabled) line.focus({ preventScroll: true });
  });

  $('entry').addEventListener('submit', e => { e.preventDefault(); submit(); line.focus(); });
  $('stop').addEventListener('click', () => { stop(); if (!touch && !line.disabled) line.focus(); });
  $('restart').addEventListener('click', restart);
  $('notice-restart').addEventListener('click', () => { restart(); });
  $('clear').addEventListener('click', () => { clearTerm(); if (!touch && !line.disabled) line.focus(); });
  $('hist-up').addEventListener('click', () => { recall(-1); line.focus(); });
  $('hist-down').addEventListener('click', () => { recall(1); line.focus(); });

  // ---- uploads (button and drag and drop)

  // a Lua string literal for a file name (names have no control characters)
  const luaString = s => '"' + s.replace(/[\\"]/g, '\\$&') + '"';
  // How to use an uploaded file: a Lua file with a plain module name
  // loads with dofile or require (package.path has "./?.lua" and the
  // current directory is the home), anything else is data for io.open.
  function useHint(name) {
    const m = /^([^./\\]+)\.lua$/.exec(name);
    if (m) return 'dofile(' + luaString(name) + ') or require ' + luaString(m[1]);
    if (/\.lua$/i.test(name)) return 'dofile(' + luaString(name) + ')';
    return 'io.open(' + luaString(name) + ')';
  }

  const uploadHooks = [];               // LuaPage.onUpload (the notebook)
  async function uploadFiles(files) {
    if (unavailable) return;            // nothing could load them
    for (const f of [...files]) {
      const name = String(f.name).replace(/^.*[\\/]/, '') || 'upload';
      let data;
      try { data = new Uint8Array(await f.arrayBuffer()); }
      catch (e) { note('-- could not read ' + name + ': ' + e.message); continue; }
      uploads.set(name, data);
      for (const hook of uploadHooks) { try { hook(name, data); } catch (e) { /* the hook's problem */ } }
      try {
        if (worker && ready) await request({ type: 'writeFile', path: HOME + name, data });
        else if (worker) worker.postMessage({ type: 'writeFile', id: ++reqId, path: HOME + name, data });
        // (with no worker, the next spawn writes it from uploads)
        note('-- uploaded ' + name + ' (' + data.length + ' bytes): ' + useHint(name));
      } catch (e) {
        // the file is in uploads, which every new interpreter is given
        if (e.restarted) note('-- uploaded ' + name + ' (' + data.length + ' bytes), for the new interpreter: ' + useHint(name));
        else note('-- upload of ' + name + ' failed: ' + e.message);
      }
    }
  }
  $('upload-btn').addEventListener('click', () => $('upload').click());
  $('upload').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    uploadFiles(files).then(() => { if (!touch && !line.disabled) line.focus(); });
  });
  const consoleBox = $('console');
  consoleBox.addEventListener('dragover', e => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      consoleBox.classList.add('drop');
    }
  });
  consoleBox.addEventListener('dragleave', e => {
    if (!consoleBox.contains(e.relatedTarget)) consoleBox.classList.remove('drop');
  });
  consoleBox.addEventListener('drop', e => {
    consoleBox.classList.remove('drop');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    uploadFiles([...e.dataTransfer.files]);
  });
  // A file dropped anywhere else would make the browser open it in place
  // of the page, and the sessions would be lost: such a drop is refused.
  // (The drop targets, the console and the notebook, cancel the events
  // first.)
  const hasFiles = e => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragover', e => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  document.addEventListener('drop', e => {
    if (hasFiles(e) && !e.defaultPrevented) e.preventDefault();
  });

  // ---- settings

  const dlg = $('settings');
  let archShown = null;                 // the build checked when the dialog opened
  function openSettings() {
    if (dlg.open) return;
    $('set-init').value = settings.init;
    $('set-args').value = settings.args;
    $('set-slice').value = settings.sliceMs;
    $('set-quotes').checked = settings.quotes;
    for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === settings.theme;
    if (!document.querySelector('input[name="theme"]:checked'))
      document.querySelector('input[name="theme"][value="auto"]').checked = true;
    for (const r of document.querySelectorAll('input[name="arch"]')) r.checked = r.value === settings.arch;
    if (!document.querySelector('input[name="arch"]:checked')) $('set-arch-auto').checked = true;
    archShown = document.querySelector('input[name="arch"]:checked').value;
    archSetting();
    dlg.returnValue = '';
    dlg.showModal();
  }
  $('settings-btn').addEventListener('click', openSettings);
  // Enter in a field saves: implicit submission would use the form's
  // first submit button, which is Cancel.  requestSubmit keeps the
  // constraint validation of the Save button.
  $('settings-form').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    $('settings-form').requestSubmit(dlg.querySelector('button[value="save"]'));
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    settings.init = $('set-init').value;
    settings.args = $('set-args').value;
    settings.sliceMs = clampSlice($('set-slice').value);
    settings.quotes = $('set-quotes').checked;
    const th = document.querySelector('input[name="theme"]:checked');
    settings.theme = th ? th.value : 'auto';
    const ar = document.querySelector('input[name="arch"]:checked');
    settings.arch = ar ? ar.value : 'auto';
    store.set('init', settings.init);
    store.set('args', settings.args);
    store.set('sliceMs', String(settings.sliceMs));
    store.set('quotes', settings.quotes ? '1' : '0');
    store.set('theme', settings.theme);
    const archStored = store.set('arch', settings.arch);
    // Choosing a build other than the one running means other modules
    // for every worker: load the page again, without the ?arch= that
    // would override the choice (the notebook saves itself on pagehide),
    // or, when the choice could not be stored, with ?arch= making it.
    // Other changes keep the page, its ?arch= and its uploads.
    const archChoice = BUILDS.length > 1 && settings.arch !== archShown ? choose(null, settings.arch) : null;
    if (archChoice && archChoice.build !== CHOICE.build) {
      const u = new URL(location.href);
      if (archStored) u.searchParams.delete('arch'); else u.searchParams.set('arch', settings.arch);
      if (u.href === location.href) location.reload(); else location.replace(u.href);
      return;
    }
    applyTheme();
    document.dispatchEvent(new CustomEvent('lua:settings', { bubbles: true, detail: { settings } }));
    // a build this browser turned out not to run: say so
    if (archChoice && archChoice.build && settings.arch !== 'auto' && archChoice.build.arch !== settings.arch)
      for (const t of archChoice.notes) note(t);
    restart();
  });

  // ---- tabs

  // in DOM order: Console, Notebook (notebook.js fills #nb-toolbar and #nb-panel)
  const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
  const tabName = t => (t.id === 'tab-notebook' ? 'notebook' : 'console');
  let tabEvents = false;                // false until the other scripts have loaded
  function selectTab(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    const nb = tab.id === 'tab-notebook';
    $('toolbar').hidden = nb;
    $('nb-toolbar').hidden = !nb;
    statusPill.style.visibility = nb ? 'hidden' : '';   // the notebook has its own
    store.set('tab', tabName(tab));
    // #notebook in the URL opens the Notebook tab: keep it in step
    try {
      const want = nb ? '#notebook' : '';
      if (location.hash !== want)
        window.history.replaceState(window.history.state, '', location.pathname + location.search + want);
    } catch (e) { /* a sandboxed page: never mind */ }
    if (focus) tab.focus();
    if (tabEvents) tabEvent(tab);
    if (!nb) {
      render();
      term.scrollTop = term.scrollHeight;
      // (arrow keys on the tabs keep the focus there)
      if (!focus && !touch && !line.disabled) line.focus();
    }
  }
  function tabEvent(tab) {
    document.dispatchEvent(new CustomEvent('lua:tab', { bubbles: true, detail: { tab: tabName(tab), id: tab.id } }));
  }
  for (const t of tabs) {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', e => {
      const i = tabs.indexOf(t);
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i + tabs.length - 1) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j !== null) { e.preventDefault(); selectTab(tabs[j], true); }
    });
  }
  addEventListener('hashchange', () => {
    const t = location.hash === '#notebook' ? $('tab-notebook') : $('tab-console');
    if (t.getAttribute('aria-selected') !== 'true') selectTab(t);
  });
  // The first tab: #notebook in the URL, else the one used last.  Its
  // panel shows at once; the lua:tab event waits for the scripts after
  // this one (notebook.js), which listen for it.
  const firstTab = location.hash === '#notebook' || (location.hash !== '#console' && store.get('tab', '') === 'notebook')
    ? $('tab-notebook') : $('tab-console');
  selectTab(firstTab);
  function startTabEvents() {
    tabEvents = true;
    tabEvent(tabs.find(t => t.getAttribute('aria-selected') === 'true'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startTabEvents);
  else setTimeout(startTabEvents);

  // ---- the page API for notebook.js

  window.LuaPage = Object.freeze({
    Q, BUILD, VERSION, ARCH, EH, HOME, HTTP_HINT,
    BUILDS,                             // [{arch, eh, dir}] the page has
    store, touch,
    settings,                           // {init, args, sliceMs, quotes, theme, arch}, live
    workerUrl,                          // the URL of a worker script, for the build chosen
    get unavailable() { return unavailable; },              // one line
    get unavailableDetail() { return unavailableDetail; },  // and what to do
    replModule,                         // Promise<WebAssembly.Module>, compiled once
    straightenQuotes, countLines,
    splitArgs,                          // the Arguments setting as a list
    uploads,                            // name -> Uint8Array
    onUpload(f) { uploadHooks.push(f); },
    uploadFiles,                        // (FileList | File[]) -> Promise
    openSettings,
    selectTab(name) { selectTab(name === 'notebook' ? $('tab-notebook') : $('tab-console')); },
  });

  // ---- start

  unavailable = LOCKOUT;
  if (unavailable) {
    term.textContent = '';
    fatal(unavailable);
    // nothing can start: Restart only would show the message again
    $('notice-restart').hidden = true;
    $('restart').disabled = true;
    $('upload-btn').disabled = true;
    unavailableDetail = unavailable.replace(/^-- /gm, '');
    unavailable = unavailableDetail.split('\n')[0];
  } else {
    spawn();
  }
})();

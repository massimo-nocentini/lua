// worker-harness.js - repl-worker.js, unmodified, in a worker thread with a browser-sized stack
//
// Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
// Copyright Notice in lua.h).
//
// usage: node [v8 flags] worker-harness.js WEB_DIR [--arch=A]
//
// WEB_DIR is a built web directory (emscripten/build/web).  Each session
// runs WEB_DIR/repl-worker.js, unmodified, in a worker_threads Worker with
// a 1 MB stack (about what browsers give workers), behind a small shim for
// the Web Worker globals it uses (self, location, importScripts,
// postMessage, onmessage, MessageChannel).  The test plays the page: it
// sends the messages of repl-worker.js's protocol (design §2.5.2) and acks
// the output it gets, as the page does after rendering.  Cases W1-W11 of
// the design's test plan.  Exits with status 1 if any case fails.
//
// With --arch=A, the modules tested are those of the architecture A of a
// page with several (WASM_WEB_ARCHS="wasm64 wasm32"), in WEB_DIR/A unless
// A is the page's own (its lua-wasm-arch); then repl-worker.js gets that
// directory in its dir= query, as on the page.

'use strict';
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const webDir = path.resolve(process.argv[2] || 'build/web');
const pageMeta = (html, name) => (new RegExp('<meta name="' + name + '" content="([^"]*)">').exec(html) || [])[1];
function moduleArch(html) {
  const own = pageMeta(html, 'lua-wasm-arch');
  const want = (process.argv.find(a => /^--arch=/.test(a)) || '').slice(7) || own;
  const has = (pageMeta(html, 'lua-wasm-builds') || own || '').split(/\s+/).map(w => w.split(':')[0]);
  if (!has.includes(want)) throw new Error('the page in ' + webDir + ' has no ' + want + ' build (only ' + has.join(', ') + ')');
  return { arch: want, sub: want === own ? '' : want + '/' };
}
const { arch, sub } = moduleArch(fs.readFileSync(path.join(webDir, 'index.html'), 'utf8'));
const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(webDir, sub, 'lua-repl.wasm')));
console.log('# ' + arch + ' module in ' + path.join(webDir, sub));

// The worker's globals.  importScripts resolves its URLs (which carry
// the dir= prefix and a ?v= query) against WEB_DIR, as a browser
// resolves them against the worker's URL.
const prelude = `
  'use strict';
  const { parentPort, workerData } = require('worker_threads');
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const dir = workerData.dir;
  globalThis.self = globalThis;
  self.location = { search: workerData.sub ? '?dir=' + encodeURIComponent(workerData.sub) : '' };
  globalThis.require = require;               // emscripten's node support
  delete globalThis.module;                   // eval workers define these:
  delete globalThis.exports;                  // UMD would pick CommonJS
  globalThis.__dirname = dir;                 // locateFile adds dir= itself
  globalThis.onmessage = null;
  globalThis.importScripts = (...files) => files.forEach(p =>
    vm.runInThisContext(fs.readFileSync(path.join(dir, p.split('?')[0]), 'utf8'), { filename: p }));
  globalThis.postMessage = m => parentPort.postMessage(m);
  // Node's MessagePort drains up to 1000 queued messages per wakeup, and
  // the worker's pump re-posts one per slice: a busy Lua would starve the
  // parentPort (no Stop for a long time).  Browsers queue both as ordinary
  // tasks and interleave them, so give the worker a fair zero-delay
  // channel built on setImmediate, which lets the poll phase run.
  globalThis.MessageChannel = class {
    constructor() {
      const port1 = { onmessage: null };
      this.port1 = port1;
      this.port2 = { postMessage: d => setImmediate(() => port1.onmessage && port1.onmessage({ data: d })) };
    }
  };
  parentPort.on('message', d => onmessage({ data: d }));
  importScripts('repl-worker.js');
`;

let failures = 0, passes = 0;
const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(c, msg) { if (!c) throw new Error('assertion failed: ' + msg); }

async function waitFor(what, pred, ms = 20000) {
  const t0 = now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (now() - t0 > ms) throw new Error('timed out after ' + ms + ' ms waiting for ' + what);
    await sleep(5);
  }
}

let current = null;

// One worker.  `autoAck' acks every output message, as the page does
// after rendering it.  `out' joins fds 1, 2 and 4 (the console as the
// page shows it); `events' are the kernel's fd-3 lines, parsed.
function session(init, { autoAck = true } = {}) {
  const s = { msgs: [], out: '', fd3: '', states: [], ready: false, exit: null, crash: null,
              markAt: 0, stateAt: 0, error: null, order: [] };
  s.w = new Worker(prelude, { eval: true, workerData: { dir: webDir, sub },
                              resourceLimits: { stackSizeMb: 1 } });
  s.w.on('error', e => { s.error = e; });
  s.w.on('message', m => {
    s.msgs.push(m);
    switch (m.type) {
    case 'ready':  s.order.push('ready'); s.ready = true; break;
    case 'output':
      if (m.fd === 3) s.fd3 += m.text; else s.out += m.text;
      if (autoAck) s.w.postMessage({ type: 'ack', bytes: m.text.length });
      break;
    case 'state':  s.order.push('state'); s.states.push(m); break;
    case 'exit':   s.exit = m.code; break;
    case 'crash':  s.crash = m.message; break;
    }
  });
  s.post = m => s.w.postMessage(m);
  s.mark = () => { s.markAt = s.out.length; s.stateAt = s.states.length; };
  s.since = () => s.out.slice(s.markAt);
  s.send = t => { s.mark(); s.post({ type: 'input', text: t, eof: false }); };
  const alive = () => {
    if (s.crash) throw new Error('crash: ' + s.crash);
    if (s.error) throw new Error('worker error: ' + s.error);
  };
  s.expectOut = (re, ms) => waitFor('output ' + re, () => { alive(); return re.test(s.since()); }, ms);
  s.last = () => s.states[s.states.length - 1];
  // the console's next prompt: a WAITING state with prompt 1 after the mark
  s.prompt = ms => waitFor('a prompt', () => {
    alive();
    return s.states.length > s.stateAt && s.last().state === 1 && s.last().prompt === 1;
  }, ms);
  s.events = () => s.fd3.split('\n').filter(Boolean).map(l => JSON.parse(l));
  s.event = (pred, what, ms) => waitFor(what, () => {
    alive();
    if (s.exit !== null) throw new Error('lua exited (' + s.exit + ')');
    return s.events().find(pred);
  }, ms);
  s.reply = (type, id, ms) => waitFor(type + ' reply ' + id,
    () => s.msgs.find(m => m.id === id && (m.type === type || m.type === 'error')), ms);
  s.close = () => s.w.terminate();
  s.post(Object.assign({ type: 'init', args: [], init: null, files: [], sliceMs: 50, wasmModule }, init));
  current = s;
  return s;
}

async function check(name, f) {
  try {
    await f();
    passes++;
    console.log('ok - ' + name);
  } catch (e) {
    failures++;
    console.log('not ok - ' + name + '\n  ' + String((e && e.message) || e));
    if (current) console.log('  output since the last input:\n  | ' +
                             current.since().slice(-600).split('\n').join('\n  | '));
  }
}

// a result line; it may follow a prompt (fd 4) on the same line
const val = v => new RegExp('(^|> )' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\n', 'm');

(async () => {
  const t0 = now();
  let S;

  await check('W1 init, ready, then a state with prompt 1', async () => {
    S = session({});
    await waitFor('ready', () => S.ready || S.crash || S.error, 30000);
    assert(S.ready, 'ready: ' + (S.crash || S.error));
    await waitFor('a state', () => S.states.length, 30000);
    assert(S.order[0] === 'ready' && S.order[1] === 'state', 'ready precedes the first state: ' + S.order.slice(0, 3));
    assert(S.states[0].state === 1 && S.states[0].prompt === 1, 'first state ' + JSON.stringify(S.states[0]));
    assert(/^Lua 5\.5\.1 {2}Copyright/.test(S.out) && /> $/.test(S.out), 'banner and prompt: ' + JSON.stringify(S.out));
  });
  if (!S || !S.ready) { console.log('# cannot continue'); process.exit(1); }

  await check('W2 an expression is evaluated', async () => {
    S.send('1 + 2\n');
    await S.expectOut(val('3'));
    await S.prompt();
  });

  await check('W3 endless loop, interrupt, then the console goes on', async () => {
    S.send('while true do end\n');
    await waitFor('two BUSY states', () => S.states.slice(S.stateAt).filter(s => s.state === 2).length >= 2);
    const t = now();
    S.mark();
    S.post({ type: 'interrupt' });
    await S.expectOut(/interrupted!/, 5000);
    assert(now() - t < 5000, 'interrupt within 5 s');
    await S.prompt();
    S.send('6 * 7\n');
    await S.expectOut(val('42'));
    await S.prompt();
  });

  await check('W4 readFile of a missing path gives an error reply', async () => {
    S.post({ type: 'readFile', id: 41, path: '/home/web_user/no-such-file' });
    const r = await S.reply('file', 41);
    assert(r.type === 'error' && r.message, 'error with a message, got ' + JSON.stringify(r));
  });

  await check('W5 writeFile, listDir, readFile, then dofile', async () => {
    const data = new TextEncoder().encode('uploaded = 17\n');
    S.post({ type: 'writeFile', id: 51, path: '/home/web_user/f.lua', data });
    assert((await S.reply('ack', 51)).type === 'ack', 'writeFile acked');
    S.post({ type: 'listDir', id: 52, path: '/home/web_user' });
    const d = await S.reply('dir', 52);
    assert(d.type === 'dir' && d.entries.includes('f.lua'), 'listed: ' + JSON.stringify(d.entries));
    S.post({ type: 'readFile', id: 53, path: '/home/web_user/f.lua' });
    const f = await S.reply('file', 53);
    assert(f.type === 'file' && Buffer.from(f.data).equals(Buffer.from(data)), 'same bytes back');
    S.send('dofile("f.lua")\n');
    await S.prompt();
    S.send('uploaded + 1\n');
    await S.expectOut(val('18'));
    await S.prompt();
  });

  await check('W6 output is paused without acks and resumes with them', async () => {
    const B = session({}, { autoAck: false });
    try {
      await waitFor('ready', () => B.ready || B.crash, 30000);
      await waitFor('first prompt', () => /> $/.test(B.out), 30000);
      B.post({ type: 'ack', bytes: B.out.length });
      const base = B.out.length;
      B.send('for i = 1, 1e7 do print(i) end print("done")\n');
      let n = -1;                       // wait until the output stops growing
      for (let k = 0; k < 100 && n !== B.out.length; k++) { n = B.out.length; await sleep(300); }
      const unacked = B.out.length - base;
      assert(!/done/.test(B.out), 'stalled before the end');
      assert(unacked >= (1 << 20) && unacked < (1 << 20) + 200000,
             'stalled just above 1 MiB unacked (' + unacked + ' chars)');
      B.post({ type: 'ack', bytes: B.out.length });
      const acked = B.out.length;
      await waitFor('more output', () => B.out.length > acked, 5000);
      B.post({ type: 'interrupt' });    // the rest would take a while
      const t = setInterval(() => B.post({ type: 'ack', bytes: 1 << 30 }), 20);
      try { await waitFor('interrupted', () => /interrupted!/.test(B.out), 30000); } finally { clearInterval(t); }
    } finally { await B.close(); }
  });

  await check('W7 input sent before ready is evaluated after it', async () => {
    const E = session({});
    try {
      E.post({ type: 'input', text: '7 * 6\n', eof: false });
      assert(!E.ready, 'posted before ready');
      await waitFor('ready', () => E.ready || E.crash, 30000);
      await E.expectOut(val('42'), 30000);
    } finally { await E.close(); }
  });

  await check('W8 bad arguments give exit {code: 1} and no ready', async () => {
    const X = session({ args: ['-x'] });
    try {
      await waitFor('exit', () => X.exit !== null || X.crash, 30000);
      assert(X.exit === 1 && !X.ready, 'exit 1 without ready, got ' + X.exit + ' ' + X.crash);
      assert(/unrecognized option '-x'/.test(X.out), 'message: ' + JSON.stringify(X.out));
    } finally { await X.close(); }
  });

  await check('W9 os.exit(3) at the prompt gives exit {code: 3}', async () => {
    S.send('os.exit(3)\n');
    await waitFor('exit', () => S.exit !== null, 10000);
    assert(S.exit === 3, 'exit code ' + S.exit);
  });

  await check('W10 a kernel request posted before ready is answered', async () => {
    const N = session({ args: ['--notebook'] });
    try {
      N.post({ type: 'request', text: 'run 1 In[1]\n6 * 7' });
      assert(!N.ready, 'posted before ready');
      const done = await N.event(e => e.ev === 'done', 'done', 30000);
      assert(done.status === 'ok' && JSON.stringify(done.values) === '["42"]', 'done ' + JSON.stringify(done));
      const evs = N.events().map(e => e.ev).join();
      assert(evs === 'hello,start,done', 'events ' + evs);
      const iReady = N.msgs.findIndex(m => m.type === 'ready');
      const iHello = N.msgs.findIndex(m => m.type === 'output' && m.fd === 3 && /"hello"/.test(m.text));
      assert(iReady >= 0 && iReady < iHello, 'ready before hello');
      await waitFor('IDLE', () => N.last() && N.last().state === 5);
      assert(!N.msgs.some(m => m.type === 'output' && m.fd !== 3), 'no banner, no prompt');
    } finally { await N.close(); }
  });

  await check('W11 a kernel request then interrupt: the cell is interrupted', async () => {
    const N = session({ args: ['--notebook'] });
    try {
      await N.event(e => e.ev === 'hello', 'hello', 30000);
      N.post({ type: 'request', text: 'run 1 In[1]\nwhile true do end' });
      await waitFor('BUSY', () => N.states.filter(x => x.state === 2).length >= 2);
      N.post({ type: 'interrupt' });
      const done = await N.event(e => e.ev === 'done', 'done', 5000);
      assert(done.status === 'interrupted', 'status ' + done.status);
      N.post({ type: 'request', text: 'run 2 In[2]\n1 + 2' });
      const d2 = await N.event(e => e.ev === 'done' && e.rid === 2, 'done 2');
      assert(JSON.stringify(d2.values) === '["3"]', 'next cell ' + JSON.stringify(d2));
    } finally { await N.close(); }
  });

  await S.close();
  if (/RangeError|RuntimeError|Aborted/.test(S.out)) { failures++; console.log('not ok - engine error in output'); }
  console.log('# ' + passes + ' passed, ' + failures + ' failed in ' +
              ((now() - t0) / 1000).toFixed(1) + ' s');
  process.exit(failures ? 1 : 0);
})();

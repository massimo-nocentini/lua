/* repl-worker.js - run the WebAssembly Lua console or notebook kernel in a Web Worker
 *
 * Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
 */

/* The page (repl.js) owns one worker per console session, and the
 * notebook (nb-kernel.js) one per kernel.  Messages:
 *
 *   page -> worker   init {args, init, files, sliceMs, wasmModule},
 *                    input {text, eof}, interrupt, ack {bytes},
 *                    request {text} (to the notebook kernel),
 *                    writeFile {id, path, data}, readFile {id, path},
 *                    listDir {id, path}
 *   worker -> page   ready, output {fd, text}, state {state, prompt},
 *                    exit {code}, crash {message}, ack {id},
 *                    file {id, path, data}, dir {id, path, entries},
 *                    error {id, message}
 *
 * output's fd is 1 (stdout) or 2 (stderr), 3 for the notebook kernel's
 * events (one JSON object per line) or 4 for the console's prompt text.
 * state is 0..5 (webrepl.h; 5, IDLE, means that the kernel waits for a
 * request) and prompt 1 or 2 while the console waits at its first-line
 * or continuation prompt, else 0.  init is LUA_INIT's value or null.
 *
 * Messages that arrive before "ready" are queued and replayed after it;
 * "ready" always precedes the first "state", and is not sent when Lua
 * exited or crashed during startup (bad arguments: exit {code: 1}).
 * Output is credit based: the page acks what it has rendered (ack.bytes
 * counts UTF-16 code units, the name is historical) and Lua is paused,
 * between slices, while more than HIGH characters are unacknowledged.
 *
 * The worker URL's ?v= query (the build id) is passed on to every script
 * and to the .wasm, so a rebuild never mixes cached files.  Its dir=
 * query names the directory of the modules of the architecture the page
 * chose (make -C emscripten WASM_WEB_ARCHS=...), such as "wasm32/";
 * without it they are beside this script. */

'use strict';

const params = new URLSearchParams(self.location.search);
const V = params.get('v') || '';
const q = V ? '?v=' + encodeURIComponent(V) : '';
const D = params.get('dir') || '';
if (!/^([a-z0-9]+\/)?$/.test(D)) throw new Error('repl-worker.js: bad module directory "' + D + '"');
importScripts(D + 'lua-repl.js' + q, 'repl-driver.js' + q);

// A zero-delay macrotask: setTimeout(f, 0) is clamped to 4 ms once nested.
const ch = new MessageChannel();
let job = null;
ch.port1.onmessage = () => { const j = job; job = null; if (j) j(); };
const schedule = f => { job = f; ch.port2.postMessage(0); };
const later = (f, ms) => setTimeout(f, ms);

const HIGH = 1 << 20;
let out = [], outLen = 0;               // [{fd, text}] in output order
let drv = null, queue = [], unacked = 0;

function addOut(fd, text) {
  const last = out[out.length - 1];
  if (last && last.fd === fd) last.text += text; else out.push({ fd, text });
  outLen += text.length;
  if (outLen > 65536) flushOut();
}

function flushOut() {
  for (const { fd, text } of out) {
    unacked += text.length;
    postMessage({ type: 'output', fd, text });
  }
  out = [];
  outLen = 0;
}

function fsOp(m, f) {
  try { f(); }
  catch (e) {
    postMessage({ type: 'error', id: m.id, message: String((e && (e.message || e.code)) || e) });
  }
}

function handle(m) {
  switch (m.type) {
  case 'input':     drv.feed(m.text, m.eof); break;
  case 'interrupt': drv.interrupt(); break;
  case 'request':   drv.post(m.text); break;
  case 'ack':
    unacked = Math.max(0, unacked - m.bytes);
    if (unacked < HIGH / 2) drv.resumeOutput();
    break;
  case 'writeFile':
    fsOp(m, () => { drv.FS.writeFile(m.path, m.data); postMessage({ type: 'ack', id: m.id }); });
    break;
  case 'readFile':
    fsOp(m, () => postMessage({ type: 'file', id: m.id, path: m.path, data: drv.FS.readFile(m.path) }));
    break;
  case 'listDir':
    fsOp(m, () => postMessage({ type: 'dir', id: m.id, path: m.path, entries: drv.FS.readdir(m.path) }));
    break;
  }
}

onmessage = async ({ data: m }) => {
  if (m.type !== 'init') {
    if (drv) handle(m); else queue.push(m);
    return;
  }
  try {
    drv = await LuaReplDriver.start(createLuaRepl, {
      args: m.args, init: m.init, files: m.files, sliceMs: m.sliceMs,
      wasmModule: m.wasmModule,
      locateFile: (p, dir) => dir + D + p + q,
      schedule, later,
      canRun: () => unacked < HIGH,
      onOutput: addOut,
      onState: (st, prompt) => { flushOut(); postMessage({ type: 'state', state: st, prompt }); },
      onExit: code => { flushOut(); postMessage({ type: 'exit', code }); },
      onCrash: msg => { flushOut(); postMessage({ type: 'crash', message: msg }); },
      onDiag: t => console.warn(t),
    });
    if (!drv) { flushOut(); return; }       // startup exit/crash already reported
    postMessage({ type: 'ready' });
    drv.begin();
    const pending = queue;
    queue = [];
    for (const x of pending) handle(x);
  } catch (e) {
    flushOut();
    postMessage({ type: 'crash', message: LuaReplDriver.describe(e) });
  }
};

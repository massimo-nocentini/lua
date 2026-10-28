// jsc-stack.js - the wasm32 Lua web module in JavaScriptCore with a small native stack
//
// Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
// Copyright Notice in lua.h).
//
// usage: jsc --maxPerThreadStackUsage=BYTES jsc-stack.js -- MODULE_DIR REPL_DRIVER
//
// MODULE_DIR holds the wasm32 lua-repl.{js,wasm} (emscripten/build/web, or
// emscripten/build/web/wasm32 with WASM_WEB_ARCHS="wasm64 wasm32");
// REPL_DRIVER is emscripten/web/repl-driver.js.  jsc is JavaScriptCore's
// shell (WebKit's Tools/Scripts/generate-bundle --bundle=jsc makes one,
// macOS has it in JavaScriptCore.framework).  Safari and every iOS browser
// run the page's wasm32 build in JavaScriptCore, whose wasm frames are
// several times V8's, in a worker with the 512 KB stack of a Darwin
// thread.
//
// Lua bounds its C recursion by LUAI_MAXCCALLS (200 levels): nested
// pcall, metamethods, gsub callbacks and the parser each count.  Every
// case below recurses through C until Lua stops it, and must print Lua's
// own result (a "stack overflow" for the Lua-only recursion, "C stack
// overflow" for the others), never end in the engine's stack overflow
// (a RangeError, which the driver reports as a crash) nor in an abort.
// If one does, emscripten/Makefile's WASM_MAXCCALLS is the remedy (see
// emscripten/README.md).  Each case starts a module of its own: the
// frames of JavaScriptCore shrink as the code tiers up, and a program
// that has not run yet is the worst case.  Run it with 524288 (iOS) and
// 393216 (a margin).  Exits with status 3 if a case fails (an uncaught
// exception: jsc's quit() always exits with 0).

'use strict';
const [modDir, driverJs] = arguments;
if (!modDir || !driverJs) throw new Error('usage: jsc jsc-stack.js -- MODULE_DIR REPL_DRIVER');

// what the shell lacks and emscripten's glue and repl-driver.js use
globalThis.console = { log: (...a) => print(a.join(' ')), warn: (...a) => print('# ' + a.join(' ')),
                       error: (...a) => print('# ' + a.join(' ')) };
if (typeof performance.now !== 'function') performance.now = () => preciseTime() * 1000;
// A streaming UTF-8 decoder: the driver decodes with {stream: true}, so
// a character split between two writes must wait for its last bytes.
class TextDecoder {
  constructor() { this.rest = []; }
  decode(b, opts) {
    const n = !b ? new Uint8Array(0) : b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b);
    const u = this.rest.length ? Uint8Array.from([...this.rest, ...n]) : n;
    this.rest = [];
    let s = '', i = 0;
    while (i < u.length) {
      const c = u[i];
      const len = c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
      if (i + len > u.length && opts && opts.stream) { this.rest = Array.from(u.subarray(i)); break; }
      i++;
      if (len === 1) s += c < 0x80 ? String.fromCharCode(c) : '�';
      else if (len === 2) s += String.fromCharCode(((c & 31) << 6) | (u[i++] & 63));
      else if (len === 3) s += String.fromCharCode(((c & 15) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63));
      else s += String.fromCodePoint(((c & 7) << 18) | ((u[i++] & 63) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63));
    }
    return s;
  }
}
class TextEncoder {
  encode(s) {
    const out = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    return new Uint8Array(out);
  }
  encodeInto(s, d) {
    const e = this.encode(s);
    d.set(e.subarray(0, d.length));
    return { read: s.length, written: Math.min(e.length, d.length) };
  }
}
globalThis.TextDecoder = TextDecoder;
globalThis.TextEncoder = TextEncoder;

load(modDir + '/lua-repl.js');
load(driverJs);
const replBytes = readFile(modDir + '/lua-repl.wasm', 'binary');

// [name, a console line, the output it must give].  The same four C
// recursions are P20 of page.spec.mjs, typed in each browser's console.
const cases = [
  ['startup', 'print("R", 1 + 1)', /^R\t2$/m],
  ['Lua recursion', 'local function f() return 1 + f() end print(pcall(f))', /^false\t.*stack overflow/m],
  ['__index chain', 'local t = setmetatable({}, {__index = function(t, k) return t[k] end})' +
   ' print(pcall(function() return t.x end))', /^false\t.*C stack overflow/m],
  ['gsub recursion', 'local function f(s) return (s:gsub(".", f)) end print(pcall(f, "a"))',
   /^false\t.*C stack overflow/m],
  ['nested pcall', 'local function f() return pcall(f) end print(select(-1, f()))', /C stack overflow/],
  ['parser', 'print(load(("("):rep(1000) .. "1" .. (")"):rep(1000)))', /^nil\t.*C stack overflow/m],
];

function run(line) {
  const wasmModule = new WebAssembly.Module(replBytes);
  return new Promise(resolve => {
    let out = '', over = false;
    const end = r => { if (!over) { over = true; resolve(r); } };
    const MARK = '#end';
    LuaReplDriver.start(createLuaRepl, {
      args: [], init: null, files: [], sliceMs: 50, wasmModule,
      schedule: f => setTimeout(f, 0), later: (f, ms) => setTimeout(f, ms),
      onOutput: (fd, t) => {
        if (fd === 4) return;           // prompts
        out += t;
        const i = out.indexOf(MARK + '\n');
        if (i >= 0) end({ out: out.slice(0, i) });
      },
      onState: () => {},
      onExit: code => end({ fail: 'lua exited (' + code + ')', out }),
      onCrash: m => end({ fail: 'crashed: ' + String(m).split('\n')[0], out }),
      onDiag: () => {},
    }).then(d => {
      if (!d) return;                   // onExit/onCrash said why
      d.begin();
      d.feed(line + '\nprint("' + MARK + '")\n');
    }, e => end({ fail: 'startup failed: ' + LuaReplDriver.describe(e).split('\n')[0], out }));
    setTimeout(() => end({ fail: 'timed out', out }), 120000);
  });
}

(async () => {
  let failures = 0;
  print('# wasm32 module in ' + modDir);
  for (const [name, line, want] of cases) {
    const r = await run(line);
    if (!r.fail && (!want.test(r.out) || /RangeError|RuntimeError|Aborted|PANIC/.test(r.out)))
      r.fail = 'unexpected output: ' + JSON.stringify(r.out.slice(-300));
    if (r.fail) { failures++; print('not ok - ' + name + ': ' + r.fail); }
    else print('ok - ' + name);
  }
  print('# ' + (cases.length - failures) + ' passed, ' + failures + ' failed');
  // quit() (status 0) also ends the timers of the cases
  if (failures) setTimeout(() => { throw new Error(failures + ' case(s) failed'); }, 0);
  else quit();
})();

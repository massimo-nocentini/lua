// repl-harness.js - the Lua console of the web module, through repl-driver.js, in node
//
// Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
// Copyright Notice in lua.h).
//
// usage: node [v8 flags] repl-harness.js WEB_DIR [--arch=A] [--only=REGEXP]
//
// WEB_DIR is a built web directory (emscripten/build/web): its index.html
// names the builds the page has (meta lua-wasm-builds, "ARCH:EH" each)
// and its own (lua-wasm-arch), whose lua-repl.{js,wasm} sit beside it;
// every other build is in WEB_DIR/ARCH/.  --arch=A selects the build
// tested (default: the page's own).  --only runs the cases whose name
// matches REGEXP.  Runs the console cases R1-R52 of the design's test
// plan in-process, through the unmodified emscripten/web/repl-driver.js,
// and exits with status 1 if any fails.  The Makefile runs it once in
// default node and once with "--liftoff --no-wasm-tier-up --stack-size=900"
// (unoptimised code and a stack near a browser worker's).
//
// The expected texts are byte-for-byte those of a native lua built from
// this tree, where a case says "exactly" (eq below): the console is a port
// of lua.c, and its messages, tracebacks and prompts must not drift.  The
// output is kept per fd: 1 stdout, 2 stderr, 4 the prompt (which the page
// shows dimmed), and in order of arrival in `log', for the cases where the
// order across fds matters.  Each send() starts a new window (mark), and
// prompt() waits for the next prompt written after it: a prompt is
// written only when the REPL has no queued line, so it also means that
// everything sent so far has been evaluated.
//
// The harness ends with an explicit process.exit: emscripten's quit_ sets
// process.exitCode on every ExitStatus (os.exit(7) leaves 7), so returning
// would exit non-zero even when every case passed.

'use strict';
const fs = require('fs');
const path = require('path');

const webDir = path.resolve(process.argv[2] || 'build/web');
const only = new RegExp((process.argv.find(a => /^--only=/.test(a)) || '--only=').slice(7));
const pageMeta = (html, name) => (new RegExp('<meta name="' + name + '" content="([^"]*)">').exec(html) || [])[1];
function moduleArch(html) {
  const own = pageMeta(html, 'lua-wasm-arch');
  const want = (process.argv.find(a => /^--arch=/.test(a)) || '').slice(7) || own;
  const has = (pageMeta(html, 'lua-wasm-builds') || own || '').split(/\s+/).map(w => w.split(':')[0]);
  if (!has.includes(want)) throw new Error('the page in ' + webDir + ' has no ' + want + ' build (only ' + has.join(', ') + ')');
  return { arch: want, sub: want === own ? '' : want + '/' };
}
const { arch, sub } = moduleArch(fs.readFileSync(path.join(webDir, 'index.html'), 'utf8'));
const modDir = path.join(webDir, sub);
const createLuaRepl = require(path.join(modDir, 'lua-repl.js'));
const Driver = require(path.join(__dirname, '..', '..', 'web', 'repl-driver.js'));
const wasmArch = require(path.join(__dirname, 'wasm-arch.js')).arch;
const { WAITING, BUSY, EXITED } = Driver;
const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(modDir, 'lua-repl.wasm')));
console.log('# ' + arch + ' module in ' + modDir);

const BANNER = 'Lua 5.5.1  Copyright (C) 1994-2026 Lua.org, PUC-Rio\n';
const HOME = '/home/web_user/';
// lua.c's checklocal warning, which a line starting with "local" gets first
const LOCALS = 'warning: locals do not survive across lines in interactive mode\n';

let failures = 0, passes = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const engineError = /RangeError|RuntimeError|Aborted/;

async function waitFor(what, pred, ms = 20000) {
  const t0 = now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (now() - t0 > ms) throw new Error('timed out after ' + ms + ' ms waiting for ' + what);
    await sleep(5);
  }
}

function assert(c, msg) { if (!c) throw new Error('assertion failed: ' + msg); }
function eq(got, want, what) {
  if (got !== want) throw new Error(what + ': expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got));
}
function starts(got, want, what) {
  if (!got.startsWith(want)) throw new Error(what + ': expected a start ' + JSON.stringify(want) + ', got ' + JSON.stringify(got));
}
function has(got, want, what) {
  if (!got.includes(want)) throw new Error(what + ': expected ' + JSON.stringify(want) + ' in ' + JSON.stringify(got.slice(-600)));
}

const sessions = [];                    // every one is checked for engine errors at the end
let current = null;                     // the session shown on failure

// One Lua console.  opts: args, init, env, files, sliceMs, noPrecompiled.
async function session(opts = {}) {
  const s = {
    out: { 1: '', 2: '', 3: '', 4: '' }, log: [], states: [], pumps: [],
    exit: null, crash: null, diag: '', at: { 1: 0, 2: 0, 3: 0, 4: 0 }, logAt: 0, stateAt: 0, pumpAt: 0,
    unacked: 0, high: Infinity, onOut: null,
  };
  sessions.push(s);
  current = s;
  s.drv = await Driver.start(createLuaRepl, {
    args: opts.args || [],
    init: opts.init === undefined ? null : opts.init,
    env: opts.env,
    files: opts.files,
    sliceMs: opts.sliceMs,
    wasmModule: opts.noPrecompiled ? undefined : wasmModule,
    schedule: f => setImmediate(() => { s.pumps.push(now()); f(); }),
    later: (f, ms) => setTimeout(() => { s.pumps.push(now()); f(); }, ms),
    canRun: () => s.unacked < s.high,
    onOutput: (fd, t) => {
      s.out[fd] = (s.out[fd] || '') + t;
      s.log.push([fd, t]);
      s.unacked += t.length;
      if (s.onOut) s.onOut(fd, t);
    },
    onState: st => s.states.push(st),
    onExit: code => { s.exit = { code, log: s.log.length }; },
    onCrash: msg => { s.crash = msg; },
    onDiag: t => { s.diag += t; },
  });
  s.mark = () => {
    for (const fd of [1, 2, 3, 4]) s.at[fd] = s.out[fd].length;
    s.logAt = s.log.length; s.stateAt = s.states.length; s.pumpAt = s.pumps.length;
  };
  s.since = fd => s.out[fd].slice(s.at[fd]);
  s.statesSince = () => s.states.slice(s.stateAt);
  s.busySince = () => s.statesSince().filter(x => x === BUSY).length;
  // the output since the mark as [fd, text] runs, adjacent pieces of one fd joined
  s.seq = () => {
    const r = [];
    for (const [fd, t] of s.log.slice(s.logAt)) {
      if (r.length && r[r.length - 1][0] === fd) r[r.length - 1][1] += t; else r.push([fd, t]);
    }
    return r;
  };
  s.send = (text, eof) => { s.mark(); s.drv.feed(text, eof); };
  s.feed = (text, eof) => s.drv.feed(text, eof);        // without a new window
  s.interrupt = () => s.drv.interrupt();
  const alive = () => {
    if (s.crash) throw new Error('crash: ' + s.crash);
    if (s.exit) throw new Error('lua exited (' + s.exit.code + ')');
  };
  s.expect = (fd, re, ms) => waitFor('fd ' + fd + ' output ' + re, () => { alive(); return re.test(s.since(fd)); }, ms);
  // the next prompt after the mark (level 1 "> " or 2 ">> ") and WAITING
  s.prompt = (level = 1, ms = 20000) => waitFor('prompt ' + level, () => {
    alive();
    return s.since(4) !== '' && s.states.length > s.stateAt &&
      s.states[s.states.length - 1] === WAITING && s.drv.state() === WAITING && s.drv.prompt() === level;
  }, ms);
  // Lua code waits for input: WAITING with no prompt
  s.reading = (ms = 20000) => waitFor('a read', () => {
    alive();
    return s.states.length > s.stateAt && s.drv.state() === WAITING && s.drv.prompt() === 0;
  }, ms);
  s.exited = (ms = 20000) => waitFor('exit', () => {
    if (s.crash) throw new Error('crash: ' + s.crash);
    return s.exit;
  }, ms);
  // one console line, evaluated: its stdout and stderr
  s.line = async (text, ms) => {
    s.send(text + '\n');
    await s.prompt(1, ms);
    return { out: s.since(1), err: s.since(2) };
  };
  s.ready = async () => {
    await waitFor('the first prompt', () => {
      alive();
      return s.out[4] !== '' && s.drv.state() === WAITING && s.drv.prompt() === 1;
    }, 30000);
  };
  if (s.drv) s.drv.begin();
  return s;
}

let shared = null;                      // S, once R1 made it
async function check(name, f) {
  if (!only.test(name) && !/^R1 /.test(name)) return;   // R1 makes the shared session
  if (shared) current = shared;
  try {
    await f();
    passes++;
    console.log('ok - ' + name);
  } catch (e) {
    failures++;
    console.log('not ok - ' + name + '\n  ' + String((e && e.message) || e));
    if (current) {
      const tail = current.log.slice(current.logAt).map(([fd, t]) => fd + '| ' + t).join('');
      console.log('  output since the last input:\n  | ' + tail.slice(-600).split('\n').join('\n  | '));
    }
  }
}

// a fresh console at its first prompt
async function fresh(opts) {
  const X = await session(opts);
  assert(X.drv, 'start returned null: ' + (X.crash || JSON.stringify(X.exit)) + ' ' + X.out[2]);
  await X.ready();
  return X;
}

(async () => {
  const t0 = now();
  let S;

  await check('R1 startup: banner, first prompt, WAITING', async () => {
    S = await session();
    assert(S.drv, 'start returned null: ' + (S.crash || JSON.stringify(S.exit)));
    await S.ready();
    assert(now() - t0 < 30000, 'ready within 30 s');
    eq(S.out[1], BANNER, 'fd 1');
    eq(S.out[4], '> ', 'fd 4');
    eq(S.out[2], '', 'fd 2');
    eq(S.drv.state(), WAITING, 'state');
    eq(S.drv.prompt(), 1, 'prompt');
  });
  if (!S || !S.drv) { console.log('# cannot continue'); process.exit(1); }
  if (!S.out[4]) await S.ready().catch(() => {});
  current = shared = S;

  await check('R2 expression', async () => {
    const r = await S.line('1+1');
    eq(r.out, '2\n', 'fd 1');
    eq(S.since(4), '> ', 'fd 4');
  });

  await check('R3 multiple results', async () => {
    eq((await S.line('1, "a", nil')).out, '1\ta\tnil\n', 'fd 1');
  });

  await check('R4 continuation', async () => {
    S.send('x =\n');
    await S.prompt(2);
    eq(S.since(4), '>> ', 'fd 4');
    S.send('5\n');
    await S.prompt(1);
    eq(S.since(4), '> ', 'fd 4 after the end of the statement');
    eq((await S.line('x')).out, '5\n', 'x');
  });

  await check('R5 statement', async () => {
    const r = await S.line('y = 3');
    eq(r.out, '', 'fd 1');
    eq(S.since(4), '> ', 'fd 4');
  });

  await check('R6 runtime error', async () => {
    const r = await S.line("error('boom')");
    eq(r.err, "stdin:1: boom\nstack traceback:\n\t[C]: in global 'error'\n\tstdin:1: in main chunk\n\t[C]: in ?\n", 'fd 2');
    eq((await S.line('1+2')).out, '3\n', 'the REPL goes on');
  });

  await check('R7 syntax error', async () => {
    eq((await S.line('x = = 1')).err, "stdin:1: unexpected symbol near '='\n", 'fd 2');
  });

  await check('R8 non-string errors', async () => {
    eq((await S.line('error(setmetatable({}, {__tostring = function() return "E!" end}))')).err, 'E!\n', '__tostring');
    eq((await S.line('error({})')).err,
       "(error object is a table value)\nstack traceback:\n\t[C]: in global 'error'\n\tstdin:1: in main chunk\n\t[C]: in ?\n",
       'a table');
    const r = await S.line('error(setmetatable({}, {__tostring = function() error("x") end}))');
    starts(r.err, "stdin:1: x\nstack traceback:\n\t[C]: in global 'error'\n\tstdin:1: in function <stdin:1>", 'a raising __tostring');
    eq((await S.line('1+1')).out, '2\n', 'no crash, the REPL goes on');
  });

  await check('R9 checklocal', async () => {
    eq((await S.line('local z = 1')).err, 'warning: locals do not survive across lines in interactive mode\n', 'fd 2');
  });

  await check('R10 print failure', async () => {
    await S.line('_print = print');
    await S.line('print = nil');
    const r = await S.line('1');
    starts(r.err, "error calling 'print' (", 'fd 2');
    await S.line('print = _print');
    eq((await S.line('1')).out, '1\n', 'print restored');
  });

  await check('R11 _PROMPT', async () => {
    S.send('_PROMPT = "lua> "\n');
    await S.prompt(1);
    eq(S.since(4), 'lua> ', 'fd 4');
    S.send('_PROMPT = nil\n');
    await S.prompt(1);
    eq(S.since(4), '> ', 'the default again');
  });

  await check('R12 io.read', async () => {
    S.send('print(io.read())\n');
    await S.reading();
    eq(S.since(4), '', 'no prompt while reading');
    S.feed('hello\n');
    await S.prompt(1);
    eq(S.since(1), 'hello\n', 'fd 1');
  });

  await check('R13 io.read formats', async () => {
    S.send('print(io.read("n", "l"))\n');
    await S.reading();
    S.feed('42 rest\n');
    await S.prompt(1);
    eq(S.since(1), '42\t rest\n', '"n", "l"');
    // the rest of the line is read too, so it is not the next REPL line
    S.send('print(io.read(3)) io.read()\n');
    await S.reading();
    S.feed('héllo\n');
    await S.prompt(1);
    eq(S.since(1), 'hé\n', '3 bytes');
  });

  await check('R14 EOF to a reader', async () => {
    S.send('print(io.read())\n');
    await S.reading();
    S.feed('', true);
    await S.prompt(1);
    eq(S.since(1), 'nil\n', 'EOF gives nil');
    eq((await S.line('1+1')).out, '2\n', 'the EOF ended that read only');
    S.send('print(io.read("a"))\n');
    await S.reading();
    S.feed('xy');
    await sleep(50);
    eq(S.drv.state(), WAITING, '"a" waits for the EOF');
    S.feed('', true);
    await S.prompt(1);
    eq(S.since(1), 'xy\n', '"a"');
    // one line, so that the "z" fed is not taken as the next REPL line
    S.send('print(io.read(0)) print(io.read())\n');
    await S.reading();
    await sleep(50);
    eq(S.drv.state(), WAITING, 'io.read(0) waits');
    eq(S.since(1), '', 'nothing printed yet');
    S.feed('z\n');
    await S.prompt(1);
    eq(S.since(1), '\nz\n', 'an empty string, then z');
  });

  await check('R15 slicing', async () => {
    S.send('for i = 1, 3e8 do end\n');
    await S.prompt(1, 120000);
    const busy = S.busySince();
    assert(busy >= 2, busy + ' BUSY states');
    console.log('#   ' + busy + ' BUSY states');
  });

  // interrupt during code started by send(): fd 2 within 5 s
  async function stopAfterBusy(code, n = 2) {
    S.send(code + '\n');
    await waitFor(n + ' BUSY states', () => S.busySince() >= n, 20000);
    const t = now();
    S.interrupt();
    await S.prompt(1, 5000);
    assert(now() - t < 5000, 'interrupted within 5 s');
    return S.since(2).replace(LOCALS, '');
  }

  await check('R16 interrupt', async () => {
    eq(await stopAfterBusy('while true do end'),
       'interrupted!\nstack traceback:\n\tstdin:1: in main chunk\n\t[C]: in ?\n', 'a top-level loop');
    starts(await stopAfterBusy('local function f() while true do end end f()'), 'stdin:1: interrupted!', 'inside a function');
    S.send('print(io.read())\n');
    await S.reading();
    const t = now();
    S.interrupt();
    await S.prompt(1, 5000);
    assert(now() - t < 5000, 'within 5 s');
    starts(S.since(2), 'stdin:1: interrupted!', 'during io.read');
    eq((await S.line('1+1')).out, '2\n', 'the REPL goes on');
  });

  await check('R17 pcall loop', async () => {
    has(await stopAfterBusy('while true do pcall(function() while true do end end) end'), 'interrupted!', 'fd 2');
  });

  await check('R18 coroutine loop', async () => {
    has(await stopAfterBusy('coroutine.wrap(function() while true do end end)()'), 'interrupted!', 'fd 2');
  });

  await check('R19 to-be-closed variables', async () => {
    const err = await stopAfterBusy('do local x <close> = setmetatable({}, {__close = function() print("closed") end}); while true do end end');
    eq(S.since(1), 'closed\n', 'fd 1');
    starts(err, 'interrupted!', 'fd 2');
    eq((await S.line('do local x <close> = setmetatable({}, {__close = function() error("c") end}) error("e") end')).err,
       "stdin:1: c\nstack traceback:\n\t[C]: in global 'error'\n\tstdin:1: in function <stdin:1>\n\t[C]: in ?\n",
       'a raising __close');
  });

  await check('R20 stale stop', async () => {
    await S.line('1');
    S.interrupt();
    await sleep(50);
    const r = await S.line('2');
    eq(r.out, '2\n', 'fd 1');
    eq(r.err, '', 'no error');
  });

  await check('R21 stop at >>', async () => {
    S.send('for i=1,2 do\n');
    await S.prompt(2);
    S.mark();
    S.interrupt();
    await S.prompt(1, 5000);
    eq(S.since(1), '\n', 'fd 1');
    eq(S.since(4), '> ', 'fd 4');
    eq(S.since(2), '', 'fd 2');
    eq((await S.line('1+1')).out, '2\n', 'the statement was discarded');
  });

  await check('R22 io.read in sort', async () => {
    has((await S.line('table.sort({3, 2, 1}, function(a, b) io.read() return a < b end)')).err, 'cannot wait', 'fd 2');
  });

  await check('R23 top-level yield', async () => {
    eq((await S.line('coroutine.yield()')).err,
       "attempt to yield from outside a coroutine\nstack traceback:\n\t[C]: in field 'yield'\n\tstdin:1: in main chunk\n\t[C]: in ?\n",
       'fd 2');
    eq((await S.line('coroutine.isyieldable()')).out, 'false\n', 'isyieldable');
    eq((await S.line('select(2, coroutine.running())')).out, 'true\n', 'running');
  });

  await check('R24 user coroutines', async () => {
    await S.line('co = coroutine.create(function(a) local b = coroutine.yield(a + 1) return b * 2 end)');
    eq((await S.line('coroutine.resume(co, 1)')).out, 'true\t2\n', 'first resume');
    eq((await S.line('coroutine.resume(co, 5)')).out, 'true\t10\n', 'second resume');
  });

  await check('R25 os.exit', async () => {
    const X = await fresh();
    X.send('os.exit(7)\n');
    await X.exited();
    eq(X.exit.code, 7, 'onExit');
    assert(X.drv.dead && X.drv.state() === EXITED, 'the driver is dead');
    X.drv.feed('1\n');                  // ignored, must not throw
    const Y = await fresh();
    Y.send('io.write("bye") os.exit(0)\n');
    await Y.exited();
    eq(Y.exit.code, 0, 'onExit');
    eq(Y.since(1), 'bye', 'bye before the exit');
  });

  await check('R26 EOF exit', async () => {
    const X = await fresh();
    X.send('', true);
    await X.exited();
    eq(X.exit.code, 0, 'at >');
    eq(JSON.stringify(X.seq()), JSON.stringify([[1, '\n']]), 'output at >');
    const Y = await fresh();
    Y.send('if x then\n');
    await Y.prompt(2);
    Y.send('', true);
    await Y.exited();
    eq(Y.exit.code, 0, 'at >>');
    eq(JSON.stringify(Y.seq()), JSON.stringify([[2, "stdin:1: 'end' expected near <eof>\n"], [4, '> '], [1, '\n']]),
       'output at >>');
    const Z = await fresh();
    await Z.line('x = setmetatable({}, {__gc = function() io.write("gc") end})');
    Z.send('', true);
    await Z.exited();
    eq(Z.since(1), '\ngc', 'the state is closed');
  });

  await check('R27 init', async () => {
    const A = await fresh({ init: 'x = 42' });
    eq((await A.line('x')).out, '42\n', 'init runs');
    const B = await session({ init: 'error("bad")' });
    await B.exited();
    eq(B.exit.code, 1, 'a failed init exits');
    starts(B.out[2], 'lua: LUA_INIT:1: bad\nstack traceback:', 'fd 2');
    const C = await fresh({ init: 'x = 42', args: ['-E'] });
    eq((await C.line('x')).out, 'nil\n', '-E ignores the init');
    const D = await fresh({ env: { LUA_PATH: 'x' } });
    eq((await D.line('package.path')).out, 'x\n', 'LUA_PATH');
    const E = await fresh({ env: { LUA_PATH: 'x' }, args: ['-E'] });
    const p = (await E.line('package.path')).out;
    assert(p.startsWith('/usr/local/share/lua/5.5/?.lua;') && p.endsWith(';./?/init.lua\n'), '-E: the default path, got ' + JSON.stringify(p));
    const F = await fresh({ init: 'warn("w")', args: ['-e', 'x=1'] });
    eq(F.out[2], 'Lua warning: w\n', 'warnings are on during init');
  });

  await check('R28 options', async () => {
    const A = await fresh({ args: ['-e', 'y=5'] });
    eq((await A.line('y')).out, '5\n', '-e');
    const B = await session({ args: ['-e', "error('e')"] });
    await B.exited();
    eq(B.exit.code, 1, '-e error: exit');
    starts(B.out[2], 'lua: (command line):1: e', '-e error: fd 2');
    const C = await session({ args: ['-e', 'os.exit(5)'] });
    await C.exited(5000);
    eq(C.exit.code, 5, '-e os.exit(5)');
    const D = await session({ args: ['-x'] });
    assert(D.drv === null, 'start returned null for -x');
    assert(D.exit && D.exit.code === 1, 'onExit(1), got ' + JSON.stringify(D.exit) + ' ' + D.crash);
    has(D.out[2] + D.diag, "unrecognized option '-x'", 'the message');
    const E = await fresh({ args: ['-W'] });
    eq((await E.line('warn("hi")')).err, 'Lua warning: hi\n', '-W');
    eq((await S.line('warn("hi")')).err, '', 'no warning without -W');
    const F = await fresh({ args: ['-e', 'warn("w4")', '-W', '-e', 'warn("w5")'] });
    eq(F.out[2], 'Lua warning: w5\n', 'warnings off until -W');
    const G = await session({ args: ['-l', 'nosuch'] });
    await G.exited();
    eq(G.exit.code, 1, '-l nosuch: exit');
    starts(G.out[2], "lua: module 'nosuch' not found:", '-l nosuch: fd 2');
    has(G.out[2], "stack traceback:\n\t[C]: in function 'require'\n\t[C]: in ?", '-l nosuch: traceback');
    const files = [{ path: HOME + 'm.lua', data: 'return {v = 1}' }, { path: HOME + 'mod-v2.lua', data: 'return 2' }];
    const H = await fresh({ args: ['-l', 'g=m'], files });
    eq((await H.line('g.v')).out, '1\n', '-l g=m');
    const I = await fresh({ args: ['-l', 'mod-v2'], files });
    eq((await I.line('mod')).out, '2\n', '-l mod-v2');
  });

  await check('R28b arg table', async () => {
    const files = [{ path: HOME + 's.lua', data: 'for i = -4, #arg do io.write(tostring(arg[i]), " ") end print(...)' }];
    const A = await fresh({ args: ['-e', 'x=1', '--', 's.lua', 'a'], files });
    eq(A.out[1], BANNER + 'lua -e x=1 -- s.lua a a\n', 'with a script');
    const B = await fresh({ args: ['-e', "for i = 0, 2 do io.write(arg[i], ' ') end print()"] });
    starts(B.out[1].slice(BANNER.length), 'lua -e ', 'without a script');
  });

  await check('R29 script', async () => {
    const A = await fresh({ args: ['s.lua', 'a', 'b'], files: [{ path: HOME + 's.lua', data: 'print(...)' }] });
    eq(A.out[1], BANNER + 'a\tb\n', 'fd 1');
    eq(A.out[4], '> ', 'then a prompt');
  });

  await check('R30 backpressure', async () => {
    S.high = 1 << 20;
    S.unacked = 0;
    S.send('for i = 1, 300000 do print(i) end\n');
    await waitFor('blocked on unacked output', () => S.unacked >= S.high && S.drv.state() === BUSY, 60000);
    const n = S.pumps.length;
    await sleep(300);
    eq(S.pumps.length, n, 'pump runs while blocked');
    eq(S.drv.state(), BUSY, 'state while blocked');
    assert(!/^300000$/m.test(S.since(1)), 'not finished while blocked');
    const ack = () => { S.unacked = 0; S.drv.resumeOutput(); };
    const timer = setInterval(ack, 20);
    ack();
    try { await S.prompt(1, 120000); } finally { clearInterval(timer); S.high = Infinity; }
    assert(/\n300000\n$/.test(S.since(1)), 'finished after the acks');
  });

  await check('R31 flood', async () => {
    S.send('for i = 1, 200000 do print(i) end\n');
    await S.prompt(1, 120000);
    const lines = S.since(1).split('\n');
    eq(lines.length, 200001, 'lines');
    for (let i = 0; i < 200000; i++) if (lines[i] !== String(i + 1)) throw new Error('line ' + (i + 1) + ' is ' + JSON.stringify(lines[i]));
    eq(lines[199999], '200000', 'the last line');
  });

  await check('R32 NUL', async () => {
    S.send('print(#io.read())\n');
    await S.reading();
    S.feed('a\0b\n');
    await S.prompt(1);
    eq(S.since(1), '3\n', 'fd 1');
  });

  await check('R33 big paste', async () => {
    S.send('s = io.read() print(#s) s = nil\n');
    await S.reading();
    S.feed('x'.repeat(17e6) + '\n');
    await S.prompt(1, 120000);
    eq(S.since(1), '17000000\n', 'fd 1');
  });

  await check('R34 os.clock counts the slices only', async () => {
    const X = await fresh();
    await sleep(2000);
    eq((await X.line('print(os.clock() < 1)')).out, 'true\n', 'fd 1');
  });

  await check('R35 os.execute and io.popen', async () => {
    eq((await S.line('print(os.execute("ls"))')).out, 'nil\tFunction not implemented\t52\n', 'os.execute');
    eq((await S.line('local ok, f = pcall(io.popen, "ls") print(ok, f)')).out, 'true\tnil\n', 'io.popen');
  });

  await check('R36 memory', async () => {
    const r = await S.line('s = string.rep("x", 2^40)', 60000);
    has(r.err, arch === 'wasm64' ? 'not enough memory' : 'resulting string too large', 'fd 2');
    eq((await S.line('1+1')).out, '2\n', 'the REPL goes on');
  });

  await check('R37 stack', async () => {
    has((await S.line('local function f() return f() + 1 end f()', 60000)).err, 'stack overflow', 'fd 2');
    eq((await S.line('1+1')).out, '2\n', 'the REPL goes on');
  });

  await check('R38 arch', async () => {
    eq((await S.line('string.packsize("T")')).out, arch === 'wasm64' ? '8\n' : '4\n', 'size_t');
    eq(wasmArch(path.join(modDir, 'lua-repl.wasm')), arch, 'wasm-arch.js');
  });

  await check('R39 require of an uploaded file', async () => {
    S.drv.FS.writeFile(HOME + 'mup.lua', 'return {v=1}');
    eq((await S.line('require("mup").v')).out, '1\n', 'fd 1');
  });

  await check('R40 notebook displays in the console', async () => {
    await S.line('notebook = require "notebook"');
    eq((await S.line('notebook.show(notebook.html("<b>x</b>"))')).out,
       '<text/html, 8 bytes: open the Notebook tab to see it>\n', 'fd 1');
  });

  await check('R41 wrap error', async () => {
    eq((await S.line('coroutine.wrap(function() error("x") end)()')).err,
       'stdin:1: stdin:1: x\nstack traceback:\n\t[C]: in ?\n\tstdin:1: in main chunk\n\t[C]: in ?\n', 'fd 2');
  });

  await check('R42 close on error through forwarding', async () => {
    await S.line('f = coroutine.wrap(function() local c <close> = setmetatable({}, {__close = function() print("cl") end}) coroutine.yield(1) error("y") end)');
    eq((await S.line('print(f())')).out, '1\n', 'first call');
    const r = await S.line('f()');
    eq(r.out, 'cl\n', 'fd 1');
    starts(r.err, "stdin:1: stdin:1: y\nstack traceback:\n\t[C]: in global 'f'", 'fd 2');
  });

  await check('R43 resume of a thread that is not suspended', async () => {
    eq((await S.line('print(coroutine.resume(coroutine.running()))')).out,
       'false\tcannot resume non-suspended coroutine\n', 'the runner');
    await S.line('g = coroutine.wrap(function() print(coroutine.resume(coroutine.running())) for i = 1, 3e8 do end end)');
    const err = await stopAfterBusy('g()');
    eq(S.since(1), 'false\tcannot resume non-suspended coroutine\n', 'inside a coroutine');
    has(err, 'interrupted!', 'still sliced and stopped');
    // lcorolib's argument check: the design's table.unpack({}, 1, 1e6)
    // fails in unpack already, natively too, so the coroutine's own stack
    // is filled first (a native lua prints the same)
    await S.line('co = coroutine.create(function() local function d(n) if n == 0 then coroutine.yield() else return d(n - 1) + 0 end end d(190000) end)');
    eq((await S.line('coroutine.resume(co)', 60000)).out, 'true\n', 'deep yield');
    eq((await S.line('coroutine.resume(co, table.unpack({}, 1, 900000))', 60000)).out,
       'false\ttoo many arguments to resume\n', 'too many arguments');
    await S.line('co = nil collectgarbage()');
  });

  await check('R44 io.lines', async () => {
    for (const it of ['io.lines()', 'io.stdin:lines()']) {
      S.send('for l in ' + it + ' do print(#l) end\n');
      await S.reading();
      S.feed('ab\ncde\n');
      await waitFor('two lines', () => S.since(1) === '2\n3\n');
      S.feed('', true);
      await S.prompt(1);
      eq(S.since(1), '2\n3\n', it);
    }
    eq((await S.line('1+1')).out, '2\n', 'the REPL goes on');
  });

  await check('R45 os.exit with close', async () => {
    const X = await fresh();
    X.send('x = setmetatable({}, {__gc = function() io.write("gc") end}) os.exit(0, true)\n');
    await X.exited();
    eq(X.exit.code, 0, 'onExit');
    eq(X.since(1), 'gc', 'the finalizer ran before the exit');
    X.drv.feed('1\n');
    X.drv.resumeOutput();
    X.drv.module._webrepl_resume();      // returns at once, touching neither G nor the runner
    X.drv.module._webrepl_interrupt();
    assert(!X.crash, 'no crash: ' + X.crash);
  });

  await check('R46 debug.sethook', async () => {
    // Unsliced, the loop overruns one slice (about a second); when the
    // coroutine returns, the runner's own hook may end that slice: at
    // most one BUSY, where a sliced loop would give some twenty.
    S.send('coroutine.wrap(function() debug.sethook(function() end, "", 1e9) for i = 1, 3e8 do end end)()\n');
    await S.prompt(1, 60000);
    assert(S.busySince() <= 1, 'a thread with a user hook is not sliced: ' + S.busySince() + ' BUSY');
    S.send('for i = 1, 3e8 do end\n');
    await S.prompt(1, 120000);
    assert(S.busySince() >= 2, 'the runner still slices: ' + S.busySince() + ' BUSY');
    has(await stopAfterBusy('debug.sethook(function() end, "", 1e9) debug.sethook() for i = 1, 3e8 do end'),
        'interrupted!', 'the glue hook is back mid-chunk');
    eq((await S.line('print(debug.gethook())')).out, 'nil\n', 'gethook hides the glue hook');
  });

  await check('R47 paste with io.read', async () => {
    S.send('x = io.read()\nhello\nprint(x)\n');
    await S.prompt(1);
    eq(S.since(1), 'hello\n', 'fd 1');
    eq(S.since(2), '', 'fd 2');
  });

  await check('R48 print override', async () => {
    await S.line('_print = print');
    await S.line('print = function(...) for i = 1, 3e8 do end end');
    has(await stopAfterBusy('1'), 'interrupted!', 'a slow print is sliced and stopped');
    await S.line('print = function(...) io.write(io.read(), "\\n") end');
    S.send('1\n');
    await S.reading();
    S.feed('q\n');
    await S.prompt(1);
    eq(S.since(1), 'q\n', 'a print that reads');
    await S.line('print = _print');
  });

  await check('R49 re-entrant feed', async () => {
    let fed = false;
    S.onOut = (fd, t) => { if (!fed && fd === 1 && /^1\n/.test(S.since(1))) { fed = true; S.drv.feed('2\n'); } };
    try {
      S.send('print(1)\n');
      await waitFor('2', () => S.since(1) === '1\n2\n' && S.drv.state() === WAITING && S.drv.prompt() === 1);
      assert(fed, 'fed from the callback');
    } finally { S.onOut = null; }
    eq((await S.line('1+1')).out, '2\n', 'no crash');
  });

  await check('R50 io.read("n", "n") on one line', async () => {
    // a numeral ends at the next space, not at the end of the line
    S.send('print(io.read("n", "n"))\n');
    await S.reading();
    S.feed('12 34\n');
    await S.prompt(1);
    eq(S.since(1), '12\t34\n', 'two numbers on one line');
    S.send('print(io.read("n", "n", "n"))\n');
    await S.reading();
    S.feed('1\n');
    await S.reading();
    S.feed('2 3\n');
    await S.prompt(1);
    eq(S.since(1), '1\t2\t3\n', 'three numbers on two lines');
  });

  await check('R51 Stop at ">>" with a line queued', async () => {
    S.send('for i = 1, 2 do\n');
    await S.prompt(2);
    S.mark();
    S.interrupt();
    S.feed('print("hello")\n');          // before the next slice
    await S.prompt(1);
    eq(S.since(1), '\nhello\n', 'the statement dropped, the queued line run');
    eq(S.since(2), '', 'no interrupted!');
  });

  await check('R52 a hook set at the prompt stays', async () => {
    // as native lua: the hook is on its one thread, for every later line
    const X = await fresh();
    await X.line('debug.sethook(function(e, l) io.write("L", l, " ") end, "l")');
    eq((await X.line('x = 1')).out, 'L1 ', 'the next line runs with the hook');
    eq((await X.line('print(select(2, debug.gethook()))')).out, 'L1 l\t0\n', 'gethook sees it');
    await X.line('debug.sethook()');
    eq((await X.line('y = 2')).out, '', 'cleared, it stays cleared');
    eq((await X.line('print(debug.gethook())')).out, 'nil\n', 'and gethook hides the glue hook');
    X.send('for i = 1, 3e8 do end\n');
    await waitFor('BUSY', () => X.busySince() >= 1, 20000);
    X.interrupt();
    await X.prompt(1, 20000);
    has(X.since(2), 'interrupted!', 'slicing and Stop are back');
  });

  for (const X of sessions) {
    if (X.crash) { failures++; console.log('not ok - crash: ' + X.crash.split('\n')[0]); }
    const all = X.log.map(([, t]) => t).join('');
    if (engineError.test(all)) {
      failures++;
      console.log('not ok - engine error in output: ' + JSON.stringify(all.match(new RegExp('.*(' + engineError.source + ').*'))[0]));
    }
  }
  console.log(`# ${passes} passed, ${failures} failed in ${((now() - t0) / 1000).toFixed(1)} s`);
  process.exit(failures ? 1 : 0);
})();

// notebook-harness.js - the Lua notebook kernel and its page client, in node
//
// Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
// Copyright Notice in lua.h).
//
// usage: node [v8 flags] notebook-harness.js WEB_DIR [--arch=A] [--only=REGEXP]
//
// WEB_DIR is a built web directory (emscripten/build/web).  Part K drives
// the kernel (the web module started as "lua --notebook") through
// repl-driver.js: it posts requests with post() ("run RID NAME\nSOURCE",
// "ping RID") and reads the events, one JSON object per line, on fd 3
// (design §2.6); a line that does not parse fails the case.  Part C
// drives the page's client, nb-kernel.js, against the real
// WEB_DIR/repl-worker.js in worker_threads (behind the shim of
// worker-harness.js), as the Notebook tab does.  Cases K1-K30 and C1-C20
// of the design's test plan.  Exits with status 1 if any case fails.
// The Makefile runs it once in default node and once with "--liftoff
// --no-wasm-tier-up --stack-size=900".
//
// With --arch=A, the modules tested are those of the architecture A of a
// page with several (WASM_WEB_ARCHS="wasm64 wasm32"), in WEB_DIR/A unless
// A is the page's own (its lua-wasm-arch); then Part C's repl-worker.js
// gets that directory in its dir= query, as on the page.  --only runs the
// cases whose name matches REGEXP (K1 and C1, which start the shared
// kernels, always run).

'use strict';
const { Worker } = require('worker_threads');
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
const createLuaRepl = require(path.join(webDir, sub, 'lua-repl.js'));
const srcWeb = path.join(__dirname, '..', '..', 'web');
const Driver = require(path.join(srcWeb, 'repl-driver.js'));
const Kernel = require(path.join(srcWeb, 'nb-kernel.js'));
const { BUSY, WAITING, SLEEPING, IDLE } = Driver;
const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(webDir, sub, 'lua-repl.wasm')));
console.log('# ' + arch + ' module in ' + path.join(webDir, sub));

let failures = 0, passes = 0, current = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
// the time since t, for a watchdog of 1000 ms: node's timers count from
// its loop clock, in whole milliseconds and read before the call, so one
// may fire a little earlier than performance.now() says
const fired = t => { const d = now() - t; return [d >= 998 && d < 5000, d]; };
function assert(c, msg) { if (!c) throw new Error('assertion failed: ' + msg); }
const J = x => JSON.stringify(x);
function eq(a, b, what) { assert(J(a) === J(b), what + ': expected ' + J(b) + ', got ' + J(a)); }
// kernelArgs() may or may not put "--notebook" first (design §2.8)
const kargs = s => { const a = Kernel.kernelArgs(s); return a[0] === '--notebook' ? a.slice(1) : a; };
// A cell that stays inside one C call for minutes: the pattern matcher
// backtracks over 300000 bytes for each start position, and the count
// hook never runs there, so neither Stop nor slicing can reach it.
const LONG_C = '("x"):rep(3e5):find(".-y")';

async function waitFor(what, pred, ms = 20000) {
  const t0 = now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (now() - t0 > ms) throw new Error('timed out after ' + ms + ' ms waiting for ' + what);
    await sleep(5);
  }
}

async function check(name, f) {
  if (!only.test(name) && !/^[KC]1 /.test(name)) return;
  try {
    await f();
    passes++;
    console.log('ok - ' + name);
  } catch (e) {
    failures++;
    console.log('not ok - ' + name + '\n  ' + String((e && e.message) || e));
    if (current && current.tail) console.log('  recent traffic:\n  | ' +
                                             current.tail().split('\n').join('\n  | '));
  }
}


// ---- Part K: the raw kernel through repl-driver.js

// One kernel.  `items' is everything it emitted, in order: {fd, text}
// for fds 1, 2 and 4 (adjacent chunks merged) and {ev} for each event;
// `pieces' counts the raw output chunks per fd.
async function kernel(opts = {}) {
  const s = { items: [], states: [], exit: null, crash: null, carry: '', rid: 0,
              unacked: 0, high: Infinity, pieces: { 1: 0, 2: 0 }, raw: '' };
  s.drv = await Driver.start(createLuaRepl, {
    args: opts.args || ['--notebook'],
    init: opts.init == null ? null : opts.init,
    files: opts.files,
    sliceMs: opts.sliceMs,
    wasmModule,
    schedule: f => setImmediate(f),
    later: (f, ms) => setTimeout(f, ms),
    canRun: () => s.unacked < s.high,
    onOutput: (fd, t) => {
      s.unacked += t.length;
      if (fd !== 3) {
        s.pieces[fd] = (s.pieces[fd] || 0) + 1;
        if (fd !== 1 || t.length < 4096) s.raw += t;
        const last = s.items[s.items.length - 1];
        if (last && last.fd === fd) last.text += t; else s.items.push({ fd, text: t });
        return;
      }
      const lines = (s.carry + t).split('\n');
      s.carry = lines.pop();
      for (const l of lines) {
        let ev;
        try { ev = JSON.parse(l); } catch (e) { s.bad = s.bad || 'not JSON: ' + J(l.slice(0, 200)); continue; }
        s.items.push({ ev });
      }
    },
    onState: st => s.states.push(st),
    onExit: code => { s.exit = code; },
    onCrash: msg => { s.crash = msg; },
  });
  current = s;
  s.tail = () => J(s.items.slice(-8)).slice(-1500);
  s.events = () => s.items.filter(i => i.ev).map(i => i.ev);
  s.find = pred => s.events().find(pred);
  s.alive = () => {
    if (s.bad) throw new Error(s.bad);
    if (s.crash) throw new Error('crash: ' + s.crash);
    if (s.exit !== null) throw new Error('exit ' + s.exit);
  };
  // post a cell; resolves with {done, items (between start and done), out, err}
  s.post = (src, name) => { const rid = ++s.rid; s.drv.post('run ' + rid + ' ' + (name || 'In[' + rid + ']') + '\n' + src); return rid; };
  s.result = async (rid, ms) => {
    const done = await waitFor('done ' + rid, () => { s.alive(); return s.find(e => e.ev === 'done' && e.rid === rid); }, ms);
    const i0 = s.items.findIndex(i => i.ev && i.ev.ev === 'start' && i.ev.rid === rid);
    const i1 = s.items.findIndex(i => i.ev === done);
    const items = s.items.slice(i0 + 1, i1);
    const text = fd => items.filter(i => i.fd === fd).map(i => i.text).join('');
    return { done, start: s.items[i0] && s.items[i0].ev, items, out: text(1), err: text(2),
             displays: items.filter(i => i.ev && i.ev.ev === 'display').map(i => i.ev) };
  };
  s.run = (src, ms, name) => s.result(s.post(src, name), ms);
  s.idle = ms => waitFor('IDLE', () => { s.alive(); return s.drv.state() === IDLE; }, ms);
  s.stateSeen = (st, from, ms) => waitFor('state ' + st, () => { s.alive(); return s.states.slice(from).includes(st); }, ms);
  s.hello = () => waitFor('hello', () => { s.alive(); return s.find(e => e.ev === 'hello'); }, 30000);
  if (s.drv) s.drv.begin();
  return s;
}

async function ok(s, src, values, ms) {
  const r = await s.run(src, ms);
  assert(r.done.status === 'ok', J(src) + ': status ' + r.done.status + ' ' + J(r.done.error));
  if (values !== undefined) eq(r.done.values, values, src);
  return r;
}

// a cell that runs until it is stopped: started, then Stop when `ready'
async function stopped(K, src, ready) {
  const from = K.states.length;
  const rid = K.post(src);
  await waitFor('the cell runs', () => { K.alive(); return ready(K.states.slice(from)); });
  const t = now();
  K.drv.interrupt();
  const r = await K.result(rid, 5000);
  assert(now() - t < 5000, 'stopped within 5 s');
  eq(r.done.status, 'interrupted', J(src) + ': status');
  eq(r.done.error && r.done.error.kind, ['interrupted'], J(src) + ': kind');
  return r;
}
const busy = sts => sts.filter(x => x === BUSY).length >= 2;

async function partK() {
  let K;

  await check('K1 hello (proto 1, version, arch), then IDLE; nothing on fds 1, 2, 4', async () => {
    K = await kernel();
    assert(K.drv, 'start returned null: ' + (K.crash || K.exit));
    const h = await K.hello();
    eq([h.proto, h.version, h.arch], [1, 'Lua 5.5.1', arch], 'hello');
    await K.idle();
    assert(K.items[0].ev === h, 'hello first: ' + J(K.items[0]));
    assert(!K.items.some(i => i.fd), 'no output on fds 1, 2 and 4: ' + J(K.items));
  });
  if (!K || !K.drv) { console.log('# cannot continue'); return; }

  await check('K2 start, stdout, stderr, then done, in order', async () => {
    const r = await K.run('print("a") io.stderr:write("b") return 1');
    eq([r.start.rid, r.start.name], [1, 'In[1]'], 'start');
    eq(r.items.map(i => i.ev ? i.ev.ev : i.fd + ':' + i.text), ['1:a\n', '2:b'], 'items between start and done');
    eq([r.done.rid, r.done.status, r.done.values], [1, 'ok', ['1']], 'done');
    assert(typeof r.done.ms === 'number', 'ms: ' + J(r.done));
    assert(K.items[K.items.length - 1].ev === r.done, 'done last');
  });

  await check('K3 values', async () => {
    await ok(K, '1, 2', ['1', '2']);
    await ok(K, 'x = 1', null);
    await ok(K, 'nil', ['nil']);
    await ok(K, 'return', null);
    await ok(K, 'x = 10\nx * 2', ['20']);
    await ok(K, '"s"', ['"s"']);
    await ok(K, '{1, 2, a = 3}', ['{1, 2, a = 3}']);
    await ok(K, 'local t = {}\n#t', ['0']);
    await ok(K, 'x = 1\n-2', null);
    await ok(K, 'x', ['-1']);
  });

  await check('K4 globals persist, locals do not', async () => {
    await ok(K, 'function f() return 7 end', null);
    await ok(K, 'f()', ['7']);
    await ok(K, 'local l = 1', null);
    await ok(K, 'l', ['nil']);
  });

  await check('K5 an incomplete cell runs nothing', async () => {
    const r = await K.run('for i=1,2 do');
    eq(r.done.status, 'incomplete', 'status');
    eq(r.done.values, null, 'values');
    eq(r.done.error.kind, ['syntax'], 'kind');
    eq(r.items.filter(i => i.fd), [], 'no stream output');
  });

  await check('K6 runtime errors: text, kind, line, chain', async () => {
    let r = await K.run('local x\nx.y = 1', undefined, 'In[3]');
    let e = r.done.error;
    eq(r.done.status, 'error', 'status');
    eq(e.kind, ['runtime'], 'kind');
    eq(e.line, 2, 'line');
    assert(e.text.startsWith('In[3]:2: attempt to index a nil value'), 'text ' + J(e.text));
    eq([e.chain[0].where, e.chain[0].proc], ['In[3]:2', 'main chunk'], 'chain[0]');
    assert(/^In\[3\]:2: attempt to index a nil value.*\nstack traceback:\n/.test(e.traceback), 'traceback ' + J(e.traceback));
    r = await K.run('function f() error("e") end', undefined, 'In[4]');
    eq(r.done.status, 'ok', 'In[4]');
    r = await K.run('f()', undefined, 'In[5]');
    e = r.done.error;
    eq(e.text, 'In[4]:1: e', 'text');
    eq(e.line, null, 'line (another cell)');
    eq(e.chain, [{ where: '[C]', proc: "global 'error'" }, { where: 'In[4]:1', proc: "function 'f'" },
                 { where: '', proc: '(...tail calls...)' }], 'chain');
  });

  await check('K7 syntax error', async () => {
    const r = await K.run('x = = 1');
    eq([r.done.status, r.done.error.kind, r.done.error.line], ['error', ['syntax'], 1], 'error');
    eq(r.done.error.chain, [], 'chain');
  });

  await check('K8 an error while formatting a value has form "print"', async () => {
    const r = await K.run('setmetatable({}, {__tostring = function() error("t") end})');
    eq([r.done.status, r.done.error.form], ['error', 'print'], 'status and form');
    eq(r.done.error.chain, [], 'chain');
    await ok(K, '1', ['1']);
  });

  await check('K9 Stop: loops, pcall, sleep, read, coroutines, __tostring', async () => {
    let r = await stopped(K, 'while true do end', busy);
    eq([r.done.error.text, r.done.error.line], ['interrupted!', null], 'top-level loop');
    await ok(K, '1 + 1', ['2']);
    r = await stopped(K, 'local function f() while true do end end f()', busy);
    eq([r.done.error.text, r.done.error.line], ['In[' + r.done.rid + ']:1: interrupted!', 1], 'in a function');
    await stopped(K, 'while true do pcall(function() while true do end end) end', busy);
    await ok(K, '2', ['2']);
    await stopped(K, 'notebook.sleep(30)', sts => sts.includes(SLEEPING));
    await stopped(K, 'io.read()', sts => sts.includes(WAITING));
    await stopped(K, 'coroutine.wrap(function() while true do end end)()', busy);
    // the glue's own tostring calls __tostring from Lua, under the hook,
    // so a value whose __tostring loops is stopped while it is formatted
    r = await stopped(K, 'setmetatable({}, {__tostring = function() while true do end end})', busy);
    eq(r.done.error.form, 'print', 'a looping __tostring: form');
    await ok(K, '3', ['3']);
  });

  await check('K10 a stale Stop is ignored; a Stop before any pump interrupts', async () => {
    await ok(K, '1', ['1']);
    K.drv.interrupt();
    await sleep(50);
    await ok(K, '2', ['2']);
    const rid = K.post('while true do end');
    K.drv.interrupt();
    eq((await K.result(rid, 5000)).done.status, 'interrupted', 'run then Stop');
  });

  await check('K11 stdin: waits, is fed, does not leak, EOF', async () => {
    let from = K.states.length;
    let rid = K.post('io.read()');
    await K.stateSeen(WAITING, from);
    K.drv.feed('x\n');
    eq((await K.result(rid)).done.values, ['"x"'], 'fed');
    from = K.states.length;
    rid = K.post('io.read()');
    await K.stateSeen(WAITING, from);
    K.drv.feed('a\nb\n');
    eq((await K.result(rid)).done.values, ['"a"'], 'the first line');
    from = K.states.length;
    rid = K.post('io.read()');
    await K.stateSeen(WAITING, from);
    await sleep(50);
    assert(!K.find(e => e.ev === 'done' && e.rid === rid), 'the next cell waits (no leak of "b")');
    K.drv.feed('c\n');
    eq((await K.result(rid)).done.values, ['"c"'], 'its own input');
    from = K.states.length;
    rid = K.post('io.read()');
    await K.stateSeen(WAITING, from);
    K.drv.feed('', true);
    eq((await K.result(rid)).done.values, ['nil'], 'EOF');
  });

  await check('K12 5 MB of output under acks', async () => {
    K.high = 1 << 20;
    K.unacked = 0;
    const timer = setInterval(() => { K.unacked = 0; K.drv.resumeOutput(); }, 20);
    try {
      const r = await ok(K, 'for i=1,1e5 do io.write(("x"):rep(50), "\\n") end', null, 120000);
      eq(r.out.length, 5100000, 'size');
    } finally { clearInterval(timer); K.high = Infinity; }
  });

  await check('K13 os.exit(3) gives onExit(3)', async () => {
    const X = await kernel();
    await X.hello();
    X.post('os.exit(3)');
    await waitFor('exit', () => X.exit !== null || X.crash);
    eq(X.exit, 3, 'exit code');
    current = K;
  });

  await check('K14 ping, a bad request, and order', async () => {
    K.drv.post('ping 9');
    const p = await waitFor('pong', () => K.find(e => e.ev === 'pong' && e.rid === 9));
    eq(p, { ev: 'pong', rid: 9 }, 'pong');
    K.drv.post('hello');
    const b = await waitFor('bad-request', () => K.find(e => e.ev === 'bad-request'));
    eq(b.text, 'hello', 'bad-request text');
    const n0 = K.events().length;
    const r1 = K.post('1');
    K.drv.post('ping 77');
    const r2 = K.post('2');
    await K.result(r2);
    eq(K.events().slice(n0).map(e => e.ev + ':' + e.rid),
       ['start:' + r1, 'done:' + r1, 'pong:77', 'start:' + r2, 'done:' + r2], 'answered in order');
  });

  await check('K15 UTF-8, NUL and invalid UTF-8 in values', async () => {
    await ok(K, '"é\\0\\255"', ['"é\\0\\xFF"']);
    await ok(K, '"\\0" .. "1"', ['"\\0001"']);
  });

  await check('K16 markup', async () => {
    // (io.write returns the file: the cell's value is not checked)
    const out = async src => (await ok(K, 'io.write(' + src + ')')).out;
    eq(await out('notebook.markup{"svg", viewBox = "0 0 1 1", width = 1, {"rect", x = 0}, {"g", {"circle", r = 1}}}'),
       '<svg viewBox="0 0 1 1" width="1"><rect x="0"/><g><circle r="1"/></g></svg>', 'svg');
    eq(await out('notebook.markup{"div", {"br"}, {"p"}, {"img", src = "a"}}'),
       '<div><br/><p></p><img src="a"/></div>', 'html');
    eq(await out('notebook.markup{"p", title = \'a"<\'}'), '<p title="a&quot;&lt;"></p>', 'escaping');
    eq(await out('notebook.markup{"div", notebook.raw("<i>x</i>")}'), '<div><i>x</i></div>', 'raw');
    const r = await ok(K, 'notebook.svg{"svg", {"rect"}}', null);
    eq(r.displays.length, 1, 'a display');
    eq(r.displays[0].mime, 'image/svg+xml', 'mime');
    assert(r.displays[0].data.includes('xmlns="http://www.w3.org/2000/svg"'), 'xmlns: ' + J(r.displays[0].data));
  });

  await check('K17 displays, show with an id, clear', async () => {
    let r = await ok(K, 'notebook.html("<b>x</b>")', null);
    eq(r.displays.map(d => [d.mime, d.data, d.id]), [['text/html', '<b>x</b>', null]], 'value display');
    r = await ok(K, 'notebook.show("a", "p") notebook.show("b", "p")', null);
    eq(r.displays.map(d => [d.data, d.id]), [['a', 'p'], ['b', 'p']], 'show with an id');
    r = await ok(K, 'notebook.clear()', null);
    assert(r.items.some(i => i.ev && i.ev.ev === 'clear' && i.ev.rid === r.done.rid), 'clear event');
  });

  await check('K18 tables', async () => {
    let r = await ok(K, 'notebook.table({{1, "a"}}, {"n", "s"})', null);
    eq(r.displays.map(d => [d.mime, d.data]), [['text/html',
      '<table><thead><tr><th>n</th><th>s</th></tr></thead><tbody><tr><td>1</td><td>a</td></tr></tbody></table>']], 'table');
    r = await ok(K, 'notebook.table({{b = 2, a = 1}})', null);
    assert(r.displays[0].data.includes('<th>a</th><th>b</th>') && r.displays[0].data.includes('<td>1</td><td>2</td>'),
           'records: ' + J(r.displays[0].data));
  });

  await check('K19 images', async () => {
    let r = await ok(K, 'notebook.image("\\x89PNG\\r\\n\\x1a\\n" .. "x")', null);
    eq(r.displays.map(d => [d.mime, d.data]), [['image/png', 'iVBORw0KGgp4']], 'bytes');
    K.drv.FS.writeFile('/home/web_user/p.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x78]));
    r = await ok(K, 'notebook.image("p.png")', null);
    eq(r.displays.map(d => [d.mime, d.data]), [['image/png', 'iVBORw0KGgp4']], 'a path');
  });

  await check('K20 init', async () => {
    const A = await kernel({ init: 'x = 5' });
    await A.hello();
    const evs = A.events().map(e => e.ev);
    eq(evs.slice(0, 2), ['init', 'hello'], 'init before hello');
    eq(A.events()[0].status, 'ok', 'init status');
    await ok(A, 'x', ['5']);
    const B = await kernel({ init: 'error("i")' });
    await B.hello();
    const i = B.events()[0];
    eq([i.ev, i.status], ['init', 'error'], 'a failed init');
    assert(/i/.test(i.error && i.error.text), 'init error text ' + J(i));
    eq(B.events()[1].ev, 'hello', 'then hello');
    await ok(B, '1 + 1', ['2']);
    current = K;
  });

  await check('K21 the kernel survives broken globals', async () => {
    const X = await kernel();
    await X.hello();
    await ok(X, 'print = nil; tostring = nil; string = nil', null);
    await ok(X, '1', ['1']);
    await ok(X, '{}', ['{}']);
    current = K;
  });

  await check('K22 io.output is restored after each cell', async () => {
    await ok(K, 'io.output("/tmp/o.txt")');
    const r = await ok(K, 'io.write("w") print("v")');
    eq(r.out, 'wv\n', 'stdout');
  });

  await check('K23 big writes and displays', async () => {
    const p0 = K.pieces[1];
    let r = await ok(K, 'io.write(("x"):rep(3e6))', undefined, 60000);
    eq(r.out.length, 3e6, 'size');
    assert(K.pieces[1] - p0 > 1, 'in more than one piece: ' + (K.pieces[1] - p0));
    r = await ok(K, 'notebook.html(("x"):rep(5e6))', null, 60000);
    eq(r.displays.map(d => [d.data, d.size]), [['', 5000000]], 'display');
  });

  await check('K24 deep recursion and huge allocations', async () => {
    let r = await K.run('local function f() return f() + 1 end f()', 60000);
    eq(r.done.status, 'error', 'recursion');
    r = await K.run('string.rep("x", 2^40)', 60000);
    eq(r.done.status, 'error', 'allocation');
    await ok(K, '1', ['1']);
  });

  await check('K25 an uploaded module', async () => {
    K.drv.FS.writeFile('/home/web_user/u.lua', 'return {v = 3}');
    await ok(K, 'dofile("u.lua").v', ['3']);
    await ok(K, 'require("u").v', ['3']);
  });

  await check('K26 warnings', async () => {
    const r = await ok(K, 'warn("@on") warn("w")', null);
    eq(r.err, 'Lua warning: w\n', 'stderr');
  });

  await check('K27 arg', async () => {
    await ok(K, 'arg[1]', ['"--notebook"']);
  });

  await check('K28 io.read(0) waits for input', async () => {
    const from = K.states.length;
    const rid = K.post('io.read(0)');
    await K.stateSeen(WAITING, from);
    await sleep(50);
    assert(!K.find(e => e.ev === 'done' && e.rid === rid), 'still waiting');
    K.drv.feed('z\n');
    eq((await K.result(rid)).done.values, ['""'], 'value');
  });

  await check('K29 a last-line call after other lines gives its values', async () => {
    let r = await ok(K, 'local t = {1, 2}\nnotebook.table({{1, 2}})', null);
    eq(r.displays.map(d => d.mime), ['text/html'], 'the call\'s display');
    await ok(K, 'x = 9\nmath.sqrt(x)', ['3.0']);
    await ok(K, 'function g() return 3, 4 end\ng()', ['3', '4']);
    await ok(K, 'function g2()\n  return {\n    1}\nend\ng2(\n)', ['{1}']);
    r = await ok(K, 'print("a")\nprint("b")', null);
    eq(r.out, 'a\nb\n', 'a call with no results shows nothing');
    // "y = f" and "(1)" are one statement, y = f(1): it is not split
    await ok(K, 'function f(a) return a + 1 end\ny = f\n(1)', null);
    await ok(K, 'y', ['2']);
    // the ';' goes at the start of the line, not into a comment
    r = await K.run('z = tostring -- c\n(print)("p")');
    eq(r.done.status, 'error', 'tostring(print)("p") is called, as natively');
    eq(r.out, '', 'print is not called');
  });

  await check('K30 repr: the items cap counts the other keys too; "SVG" is not <svg>', async () => {
    await ok(K, 'notebook.repr({a = 1, b = 2, c = 3}, {items = 0})', ['"{…}"']);
    const r = await ok(K, 'local t = {} for i = 1, 100 do t[i] = i end t.a = 1 t.b = 2 return notebook.repr(t)');
    assert(/, 99, 100, …}"$/.test(r.done.values[0]), '100 items: ' + J(r.done.values[0].slice(-40)));
    const v = await ok(K, '{"SVG", {"rect"}}');
    eq(v.displays.length, 0, 'an ordinary value');
    eq(v.done.values, ['{"SVG", {"rect"}}'], 'shown as a table');
  });

  if (/RangeError|RuntimeError|Aborted/.test(K.raw)) { failures++; console.log('not ok - engine error in output'); }
}


// ---- Part C: nb-kernel.js against the real repl-worker.js

const prelude = `
  'use strict';
  const { parentPort, workerData } = require('worker_threads');
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const dir = workerData.dir;
  globalThis.self = globalThis;
  self.location = { search: workerData.sub ? '?dir=' + encodeURIComponent(workerData.sub) : '' };
  globalThis.require = require;
  delete globalThis.module;
  delete globalThis.exports;
  globalThis.__dirname = dir;
  globalThis.onmessage = null;
  globalThis.importScripts = (...files) => files.forEach(p =>
    vm.runInThisContext(fs.readFileSync(path.join(dir, p.split('?')[0]), 'utf8'), { filename: p }));
  globalThis.postMessage = m => parentPort.postMessage(m);
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

let workers = 0;
function createWorker() {
  const w = new Worker(prelude, { eval: true, workerData: { dir: webDir, sub }, resourceLimits: { stackSizeMb: 1 } });
  workers++;
  const shim = {
    onmessage: null, onerror: null,
    postMessage: m => w.postMessage(m),
    terminate: () => { w.terminate(); },
  };
  w.on('message', d => shim.onmessage && shim.onmessage({ data: d }));
  w.on('error', e => shim.onerror && shim.onerror({ message: String(e) }));
  return shim;
}

function client(extra = {}) {
  const c = { cells: {}, states: [], logs: [], all: [] };
  c.k = Kernel.create(Object.assign({
    createWorker,
    getModule: () => Promise.resolve(wasmModule),
    args: () => '',
    init: () => null,
    files: () => [],
    sliceMs: () => 50,
    schedule: f => setImmediate(f),
    onCell: (id, ev) => { (c.cells[id] = c.cells[id] || []).push(ev); c.all.push([id, ev]); },
    onState: st => c.states.push(st),
    onLog: (kind, text) => c.logs.push([kind, text]),
  }, extra));
  c.types = id => (c.cells[id] || []).map(e => e.type);
  c.stream = id => (c.cells[id] || []).filter(e => e.type === 'stream').map(e => e.text).join('');
  c.tail = () => J({ states: c.states.slice(-6), logs: c.logs.slice(-4), all: c.all.slice(-4) }).slice(-1500);
  current = c;
  return c;
}

async function partC() {
  let C;

  await check('C1 start() resolves on hello: starting, then idle', async () => {
    C = client();
    eq(C.k.state, 'off', 'off at first');
    await C.k.start();
    eq(C.states, ['starting', 'idle'], 'states');
    assert(C.k.info && C.k.info.proto === 1, 'info ' + J(C.k.info));
  });
  if (!C || C.k.state !== 'idle') { console.log('# cannot continue'); return; }

  await check('C2 run gives queued, start, done; the promise resolves with done', async () => {
    const d = await C.k.run('a', '1 + 2');
    eq(C.types('a'), ['queued', 'start', 'done'], 'events');
    eq(C.cells.a[1], { type: 'start', count: 1, name: 'In[1]' }, 'start');
    assert(d === C.cells.a[2] && d.status === 'ok', 'resolved with done');
    eq(d.values, ['3'], 'values');
    eq(d.count, 1, 'count');
    assert(typeof d.wallMs === 'number' && typeof d.ms === 'number', 'times');
    eq(C.k.state, 'idle', 'idle');
  });

  await check('C3 runMany: stop on error cancels the rest', async () => {
    const r = await C.k.runMany([{ cellId: 'm1', source: 'print("one") return 1' },
                                 { cellId: 'm2', source: 'error("two")' },
                                 { cellId: 'm3', source: '3' }]);
    eq(r.map(e => e.status || e.reason), ['ok', 'error', 'previous cell failed'], 'outcomes');
    eq(C.stream('m1'), 'one\n', 'stream');
    eq(C.types('m3'), ['queued', 'cancelled'], 'm3 events');
    eq(C.k.execCount, 3, 'counter');
  });

  await check('C4 stop() interrupts the running cell and cancels the queue', async () => {
    const p = C.k.run('loop', 'while true do end');
    const q = C.k.run('after', '1');
    await waitFor('busy', () => C.k.current === 'loop' && C.k.state === 'busy');
    await sleep(100);
    C.k.stop();
    const d = await p;
    eq(d.status, 'interrupted', 'interrupted');
    eq((await q).reason, 'stopped', 'queued cancelled');
    eq((await C.k.run('next', '2 * 21')).values, ['42'], 'next cell');
  });

  await check('C5 watchdog: an unresponsive Stop kills and respawns the kernel', async () => {
    const W = client({ watchdogMs: 1000 });
    await W.k.run('d', 'small = 1');
    const before = workers;
    const p = W.k.run('long', LONG_C);
    await waitFor('busy', () => W.k.state === 'busy');
    await sleep(200);
    const t = now();
    W.k.stop();
    const d = await p;
    eq([d.status, d.reason], ['killed', 'unresponsive'], 'killed');
    assert(fired(t)[0], 'after watchdogMs: ' + fired(t)[1]);
    assert(W.logs.some(([k]) => k === 'kernel'), 'kernel log ' + J(W.logs));
    const r = await W.k.run('after', 'small');
    eq(r.values, ['nil'], 'a fresh kernel');
    eq(r.count, 1, 'counter restarted');
    assert(workers === before + 1, 'one respawn');
    W.k.dispose();
    current = C;
  });

  // K9's looping __tostring through the client: the Stop reaches the
  // formatter in-process, so the watchdog never fires and the kernel
  // (its variables) survives
  await check('C5b a value whose __tostring loops: Stop interrupts it, no respawn', async () => {
    const W = client({ watchdogMs: 1000 });
    await W.k.run('d', 'small = 1');
    const before = workers;
    const p = W.k.run('ts', 'setmetatable({}, {__tostring = function() while true do end end})');
    await waitFor('busy', () => W.k.state === 'busy');
    await sleep(200);
    W.k.stop();
    const d = await p;
    eq([d.status, d.error && d.error.form], ['interrupted', 'print'], 'interrupted while formatted');
    eq((await W.k.run('after', 'small')).values, ['1'], 'the same kernel');
    assert(workers === before, 'no respawn');
    W.k.dispose();
    current = C;
  });

  await check('C6 restart() kills the running cell; the counter restarts', async () => {
    const p = C.k.run('r1', 'while true do end');
    const q = C.k.run('r2', '1');
    await waitFor('busy', () => C.k.current === 'r1');
    await C.k.restart();
    eq([(await p).status, (await p).reason], ['killed', 'restart'], 'killed');
    eq((await q).reason, 'restart', 'queue cancelled');
    eq(C.k.execCount, 0, 'counter reset');
    const d = await C.k.run('r3', 'nb = 1\nnb');
    eq([d.count, d.values], [1, ['1']], 'fresh kernel');
  });

  await check('C7 input: waiting, then the text fed ends it', async () => {
    const p = C.k.run('in', 'io.read()');
    await waitFor('input', () => (C.cells.in || []).some(e => e.type === 'input' && e.waiting));
    eq(C.k.state, 'input', 'state input');
    C.k.input('x\n');
    const d = await p;
    eq(d.values, ['"x"'], 'value');
    const t = C.types('in');
    assert(t.indexOf('input') < t.lastIndexOf('input') && t[t.length - 1] === 'done', 'input true, input false, done: ' + J(t));
    eq(C.cells.in.filter(e => e.type === 'input').map(e => e.waiting), [true, false], 'waiting flags');
    C.k.input('ignored\n');                  // not waiting: ignored
    eq((await C.k.run('in2', '1 + 1')).values, ['2'], 'next');
  });

  await check('C8 os.exit(2): done exited, state dead; the next run respawns', async () => {
    const d = await C.k.run('ex', 'os.exit(2)');
    eq([d.status, d.code], ['exited', 2], 'exited');
    eq(C.k.state, 'dead', 'dead');
    const r = await C.k.run('again', '1 + 2');
    eq(r.values, ['3'], 'respawned');
    assert(C.logs.some(([k, t]) => k === 'kernel' && t === 'kernel restarted'), 'logged ' + J(C.logs));
  });

  await check('C9 an output flood with batched acks: complete, ordered, done last', async () => {
    const d = await C.k.run('flood', 'for i = 0, 199999 do print(i) end');
    eq(d.status, 'ok', 'status');
    const s = C.stream('flood');
    let expect = '';
    for (let i = 0; i < 200000; i++) expect += i + '\n';
    assert(s === expect, 'all lines in order (' + s.length + ' of ' + expect.length + ')');
    eq(C.types('flood').slice(-1), ['done'], 'done last');
  });

  await check('C10 kernelArgs keeps only what the kernel can use', async () => {
    eq(kargs('-x foo -W'), ['-W'], '-x foo dropped, -W kept');
    eq(kargs('-W -E -l m -lm2 -l g=m3 -e "x=1" -i -v s.lua a'), ['-W', '-E', '-l', 'm', '-lm2', '-l', 'g=m3'], 'mixed');
    eq(kargs(''), [], 'empty');
  });

  await check('C11 rich output and stderr reach the cell; cancel() removes queued cells', async () => {
    // (stdout is line buffered, as on a tty: "o" ends its line to come first)
    const p = C.k.run('slow', 'io.write("o\\n") io.stderr:write("e") notebook.show(notebook.html("<i>h</i>"), "id1") ' +
                              'notebook.clear() notebook.sleep(1) return 5');
    const q = C.k.run('gone', '1');
    C.k.cancel('gone');
    eq((await q).reason, 'removed', 'removed');
    const d = await p;
    eq(d.values, ['5'], 'value');
    eq(C.cells.slow.map(e => e.type), ['queued', 'start', 'stream', 'stream', 'display', 'clear', 'done'], 'events');
    eq(C.cells.slow[4], { type: 'display', mime: 'text/html', data: '<i>h</i>', id: 'id1' }, 'display');
    eq(C.cells.slow.slice(2, 4).map(e => e.name + ':' + e.text), ['stdout:o\n', 'stderr:e'], 'streams');
    assert(C.states.includes('sleeping'), 'sleeping seen');
  });

  await check('C11b a display too large to send has its size', async () => {
    const d = await C.k.run('big', 'notebook.show(notebook.html(("x"):rep(5000000))) return 1');
    eq(d.values, ['1'], 'value');
    eq(C.cells.big.filter(e => e.type === 'display'), [{ type: 'display', mime: 'text/html', data: '', id: null, size: 5000000 }], 'display');
  });

  await check('C12 init and uploads through the client; the startup log', async () => {
    const U = client({ init: () => 'io.write("from init") rc = 1 notebook.show("init show") notebook.show(notebook.html("<b>x</b>"))',
                       files: () => [{ path: '/home/web_user/up.lua', data: new TextEncoder().encode('up = 2') }] });
    const d = await U.k.run('u', 'dofile("up.lua") return rc + up');
    eq(d.values, ['3'], 'values');
    assert(U.logs.some(([k]) => k === 'init'), 'init log ' + J(U.logs));
    assert(U.logs.some(([k, t]) => k === 'stdout' && /from init/.test(t)), 'init output in the log');
    // displays outside a cell (rid 0) are logged
    assert(U.logs.some(([k, t]) => /init show/.test(t)), 'the text display in the log ' + J(U.logs));
    assert(U.logs.some(([k]) => k === 'display'), 'the html display in the log ' + J(U.logs));
    assert(!U.logs.some(([k]) => k === 'protocol'), 'no protocol error ' + J(U.logs));
    U.k.writeFile('/home/web_user/w.lua', new TextEncoder().encode('w = 3'));
    eq((await U.k.run('w', 'dofile("w.lua") return w')).values, ['3'], 'writeFile');
    U.k.dispose();
    eq((await U.k.run('x', '1')).reason, 'disposed', 'disposed');
    current = C;
  });

  await check('C13 a kernel that cannot start rejects start() with a reason', async () => {
    const B = client({ getModule: () => Promise.reject(new Error('no module here')) });
    let why = null;
    await B.k.start().catch(e => { why = e; });
    assert(why && /no module here/.test(why.reason), 'rejected: ' + J(why));
    eq(B.k.state, 'unavailable', 'state');
    eq((await B.k.run('x', '1')).reason, 'kernel unavailable', 'run cancelled');
    B.k.dispose();
    current = C;
  });

  await check('C14 restart() while starting: both promises resolve on the new hello', async () => {
    const R = client();
    const p1 = R.k.start();
    const p2 = R.k.restart();
    await Promise.all([p1, p2]);
    eq(R.k.state, 'idle', 'idle');
    eq((await R.k.run('x', '1 + 1')).values, ['2'], 'runs');
    R.k.dispose();
    current = C;
  });

  // an -l or -e error does not end the kernel (design §2.2.1); an init
  // that exits does
  await check('C15 a kernel that exits while starting: start() rejects, its message is logged', async () => {
    const F = client({ init: () => 'io.stderr:write("bye from init\\n") os.exit(4)' });
    let why = null;
    await F.k.start().catch(e => { why = e; });
    assert(why && /exited/.test(why.reason), 'rejected: ' + J(why));
    eq(F.k.state, 'dead', 'dead');
    assert(F.logs.some(([k, t]) => k === 'stderr' && /bye from init/.test(t)), 'stderr logged ' + J(F.logs));
    eq((await F.k.run('x', '1')).reason, 'kernel exited', 'run cancelled');
    F.k.dispose();
    current = C;
  });

  // The slice that wakes from a sleep, or gets the input, runs into a
  // long C call without reporting: the client still says sleeping or
  // input, and Stop must kill the kernel all the same.
  await check('C16 watchdog: Stop after a sleep, in a long C call, kills the kernel', async () => {
    const W = client({ watchdogMs: 1000 });
    const p = W.k.run('long', 'notebook.sleep(1) return ' + LONG_C);
    await waitFor('sleeping', () => W.k.state === 'sleeping');
    await sleep(1500);
    eq(W.k.state, 'sleeping', 'still sleeping for the client');
    const t = now();
    W.k.stop();
    const d = await p;
    eq([d.status, d.reason], ['killed', 'unresponsive'], 'killed');
    { const [ok, ms] = fired(t); assert(ok, 'after watchdogMs: ' + ms); }
    eq((await W.k.run('after', '1 + 2')).values, ['3'], 'respawned');
    W.k.dispose();
    current = C;
  });

  await check('C17 input: busy once it is sent; Stop in the C call that follows kills the kernel', async () => {
    const W = client({ watchdogMs: 1000 });
    const p = W.k.run('in', 'io.read() return ' + LONG_C);
    await waitFor('input', () => W.k.state === 'input');
    W.k.input('x\n');
    eq(W.k.state, 'busy', 'busy at once');
    await waitFor('the stdin box goes', () => W.cells.in.filter(e => e.type === 'input').length === 2);
    eq(W.cells.in.filter(e => e.type === 'input').map(e => e.waiting), [true, false], 'waiting flags');
    const t = now();
    W.k.stop();
    const d = await p;
    eq([d.status, d.reason], ['killed', 'unresponsive'], 'killed');
    { const [ok, ms] = fired(t); assert(ok, 'after watchdogMs: ' + ms); }
    W.k.dispose();
    current = C;
  });

  await check('C18 input read twice: the stdin box stays up between the lines', async () => {
    const p = C.k.run('in2x', 'return io.read(), io.read()');
    await waitFor('input', () => C.k.state === 'input');
    C.k.input('a\n');
    await waitFor('input again', () => C.k.state === 'input');
    C.k.input('b\n');
    eq((await p).values, ['"a"', '"b"'], 'values');
    eq(C.cells.in2x.filter(e => e.type === 'input').map(e => e.waiting), [true, false], 'waiting flags');
  });

  // (chicken's C19, a continuation of the .csirc re-entered from a cell,
  // has no Lua counterpart: Lua has no first-class continuations.)

  // More input sent just after the read (the stdin box stays up for a
  // while) reaches a kernel already at IDLE: the worker reports IDLE
  // again for a slice that ran nothing.  The shim holds that second
  // input until the cell's done arrives, and the client sees done only
  // after both IDLE states, behind which the next cell is posted.
  await check('C20 IDLE from input sent after a cell ended does not end the next cell', async () => {
    let held = null, inputs = 0, hold = null, states = 0;
    const S = client({
      createWorker: () => {
        const w = createWorker(), real = w.postMessage;
        w.postMessage = m => {
          if (m.type === 'input' && ++inputs === 2) held = m; else real(m);
        };
        const shim = { onmessage: null, onerror: null, postMessage: m => w.postMessage(m),
                       terminate: () => w.terminate() };
        w.onerror = e => shim.onerror && shim.onerror(e);
        w.onmessage = e => {
          const m = e.data;
          if (!hold && held && m.type === 'output' && m.fd === 3 && m.text.includes('"ev":"done"')) {
            hold = [];
            real(held);
          }
          if (hold) {
            hold.push(e);
            if (m.type === 'state' && ++states === 2) {
              const q = hold;
              hold = held = null;
              for (const x of q) shim.onmessage && shim.onmessage(x);
            }
            return;
          }
          if (shim.onmessage) shim.onmessage(e);
        };
        return shim;
      },
    });
    const pa = S.k.run('a', 'io.read() io.write("A ran") return 1');
    const pb = S.k.run('b', 'io.write("B ran") return 42');
    const pc = S.k.run('c', '1 + 2');
    await waitFor('input', () => S.k.state === 'input');
    S.k.input('x\n');
    S.k.input('', true);                      // the box is still up: posted
    eq(inputs, 2, 'both inputs posted');
    const a = await pa, b = await pb, c = await pc;
    eq([a.status, S.stream('a')], ['ok', 'A ran'], 'a');
    eq([b.status, b.values, S.stream('b')], ['ok', ['42'], 'B ran'], 'b');
    eq([c.status, c.values], ['ok', ['3']], 'c');
    eq(states, 2, 'both IDLE states held');
    assert(!S.logs.some(([k]) => k === 'protocol'), 'no protocol error: ' + J(S.logs));
    eq(S.k.state, 'idle', 'idle');
    S.k.dispose();
    current = C;
  });

  C.k.dispose();
}

(async () => {
  const t0 = now();
  await partK();
  await partC();
  console.log('# ' + passes + ' passed, ' + failures + ' failed in ' +
              ((now() - t0) / 1000).toFixed(1) + ' s');
  // emscripten's quit_ leaves process.exitCode set by os.exit(3)
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('not ok - ' + (e && e.stack || e)); process.exit(1); });

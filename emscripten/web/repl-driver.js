/* repl-driver.js - drive the WebAssembly Lua console and notebook kernel (lua-repl.js) from JavaScript
 *
 * Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
 */

/* UMD: a CommonJS module in node (tests), the global LuaReplDriver in a
 * worker (importScripts).
 *
 *   const drv = await LuaReplDriver.start(createLuaRepl, options);
 *
 * starts the module (main writes the banner, queues the LUA_INIT, -e, -l
 * and script jobs, and writes the first prompt when there are none) and
 * returns a driver object, or null when Lua already exited or crashed
 * during startup (onExit/onCrash have then been called: bad arguments
 * exit with code 1).  It rejects only when the module itself fails to
 * load or instantiate, and then calls neither.  Options:
 *
 *   args         lua's arguments, after argv[0] = "lua" ("--notebook"
 *                first selects the notebook kernel)
 *   init         LUA_INIT's value (Lua code, or "@file"), or null for none
 *   env          {NAME: value} set in the environment before main runs;
 *                init, when given, wins over an env LUA_INIT
 *   files        [{path, data}] written into MEMFS before main runs
 *   sliceMs      time slice in ms (default 50)
 *   wasmModule   a precompiled WebAssembly.Module (optional)
 *   locateFile   emscripten's locateFile hook (optional)
 *   schedule(f)  run f soon (a macrotask, so JS events get a turn)
 *   later(f,ms)  run f after ms milliseconds
 *   canRun()     optional backpressure: false stops pumping BUSY slices
 *                until resumeOutput() is called
 *   onOutput(fd, text)  Lua output, decoded UTF-8: fd 1 stdout, fd 2
 *                stderr, fd 3 the notebook kernel's events (one JSON
 *                object per line), fd 4 the console's prompt text
 *   onState(st, prompt)  after every slice; st is one of the state
 *                constants, prompt is 1 or 2 while the console waits at
 *                its first-line or continuation prompt, else 0
 *   onExit(code), onCrash(message)  called once; the driver is then dead
 *   onDiag(text) C-level stderr before the module is ready (default
 *                console.warn)
 *
 * feed() does not add a newline: the console reads whole lines, so input
 * should be "\n"-terminated; feed('', true) is an end of file (Ctrl+D).
 * post(text) hands the notebook kernel one whole request ("run RID
 * NAME\nSOURCE" or "ping RID", see webrepl-main.c); requests queue in
 * order.  describe(e) gives an error's message and stack, as onCrash has
 * them.
 *
 * A callback that runs inside a slice (onOutput, reached from a write in
 * the middle of Lua code) may call feed, post or interrupt: those calls
 * are deferred until the slice has returned, then applied in order before
 * the new state is reported.  The C side tolerates them anyway; deferring
 * keeps the order of effects easy to reason about.
 *
 * An exit (os.exit, an end of file at the prompt, a failed startup job)
 * makes emscripten's proc_exit throw ExitStatus out of webrepl_resume;
 * that is the only in-slice exit signal, and any other exception is a
 * crash. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LuaReplDriver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RUNNING = 0, WAITING = 1, BUSY = 2, EXITED = 3, SLEEPING = 4, IDLE = 5;

  // An error's message and stack: V8's stack begins with the message,
  // JavaScriptCore's and SpiderMonkey's have the frames only.
  function describe(e) {
    if (!e || typeof e !== 'object') return String(e);
    const head = String(e), stack = e.stack ? String(e.stack) : '';
    return !stack || stack.startsWith(head) ? stack || head : head + '\n' + stack;
  }

  async function start(createModule, o) {
    let M = null, dead = false, scheduled = false, ready = false;
    let inSlice = false, deferred = [];
    const earlyErr = [];
    // one streaming decoder per fd: a write may end inside a UTF-8 sequence
    const dec = { 1: new TextDecoder(), 2: new TextDecoder(), 3: new TextDecoder(), 4: new TextDecoder() };

    function finish(kind, v) {
      if (dead) return;
      dead = true;
      if (kind === 'exit') o.onExit(v); else o.onCrash(v);
    }
    function fail(e) {
      if (e && e.name === 'ExitStatus') finish('exit', e.status);
      else finish('crash', describe(e));
    }
    function guard(f) {
      if (dead) return EXITED;
      try { return f(); } catch (e) { fail(e); return EXITED; }
    }
    // A pump soon (no ms), or one at a SLEEPING state's wake-up time.
    // webrepl_wakeup_ms() is the whole time left, so a feed, post or
    // interrupt must not wait behind that timer: an immediate pump
    // retires the pending timer (its generation no longer matches), and
    // the state it reports arms a new one if Lua still sleeps.
    let timerSet = false, timerGen = 0;
    function kick(ms) {
      if (dead) return;
      if (ms) {
        if (scheduled || timerSet) return;
        timerSet = true;
        const g = ++timerGen;
        o.later(() => { if (g === timerGen) { timerSet = false; pump(); } }, ms);
      } else if (!scheduled) {
        scheduled = true;
        o.schedule(() => { scheduled = false; timerGen++; timerSet = false; pump(); });
      }
    }
    function report(st) {
      if (dead) return;
      o.onState(st, M._webrepl_prompt());
      if (st === BUSY) { if (!o.canRun || o.canRun()) kick(); }   // else resumeOutput()
      else if (st === SLEEPING) kick(Math.max(1, M._webrepl_wakeup_ms()));
    }
    function pump() {
      inSlice = true;
      let st;
      try { st = guard(() => M._webrepl_resume()); }
      finally { inSlice = false; }
      // the calls callbacks made during the slice, in order (each may kick)
      while (deferred.length) {
        const d = deferred;
        deferred = [];
        for (const f of d) f();
      }
      report(st);
    }
    // f now, or after the slice when called from inside one
    function outside(f) {
      if (inSlice) deferred.push(f); else f();
    }

    const opts = {
      arguments: [...(o.args || [])],
      thisProgram: 'lua',
      stdin: () => null,                    // never window.prompt()
      // the fd 1-4 stream ops of webrepl-main.c call this with each write
      onLuaOutput: (fd, bytes) =>
        o.onOutput(fd, (dec[fd] || (dec[fd] = new TextDecoder())).decode(bytes, { stream: true })),
      print: t => o.onOutput(1, t + '\n'),  // C-level stdio before main replaces it
      printErr: t => {
        if (ready) o.onOutput(2, t + '\n');
        else { earlyErr.push(t); (o.onDiag || console.warn)(t + '\n'); }
      },
      // before main returned, start() reports the failure instead
      onAbort: what => {
        if (ready) fail(new Error('abort: ' + what)); else earlyErr.push('abort: ' + what);
      },
      preRun: [mod => {
        mod.FS.chdir('/home/web_user');
        const env = o.env || {};
        for (const k of Object.keys(env)) mod.ENV[k] = String(env[k]);
        if (o.init != null && o.init !== '') mod.ENV.LUA_INIT = String(o.init);
        for (const f of o.files || []) mod.FS.writeFile(f.path, f.data);
      }],
    };
    if (o.locateFile) opts.locateFile = o.locateFile;
    let loadFailed;
    const loadFailure = new Promise((_, reject) => { loadFailed = reject; });
    if (o.wasmModule) opts.instantiateWasm = (imports, ok) => {
      WebAssembly.instantiate(o.wasmModule, imports)
        .then(inst => ok(inst, o.wasmModule), loadFailed);
      return {};
    };

    M = await Promise.race([createModule(opts), loadFailure]);
    if (!M._webrepl_started()) {            // bad arguments, or a failure inside main
      if (M._webrepl_exited()) {
        // C-level messages (a panic) went to onDiag only so far
        if (earlyErr.length) o.onOutput(2, earlyErr.join('\n') + '\n');
        finish('exit', M._webrepl_exit_code());
      } else finish('crash', 'runtime exited during startup\n' + earlyErr.join('\n'));
      return null;
    }
    ready = true;
    if (o.sliceMs) M._webrepl_set_slice_ms(o.sliceMs);

    const api = {
      feed(text, eof) {
        outside(() => {
          if (dead) return;
          // with an explicit length, so that NUL characters get through
          const p = M.stringToNewUTF8(text);
          M._webrepl_feed(p, M.lengthBytesUTF8(text), eof ? 1 : 0);
          M._free(p);
          kick();
        });
      },
      post(text) {
        outside(() => {
          if (dead) return;
          const p = M.stringToNewUTF8(text);
          M._webrepl_post(p, M.lengthBytesUTF8(text));
          M._free(p);
          kick();
        });
      },
      interrupt() {
        outside(() => {
          if (dead) return;
          M._webrepl_interrupt();
          kick();
        });
      },
      resumeOutput() { if (!dead && !inSlice && M._webrepl_state() === BUSY) kick(); },
      state() { return dead ? EXITED : M._webrepl_state(); },
      prompt() { return dead ? 0 : M._webrepl_prompt(); },
      get FS() { return M.FS; },
      get module() { return M; },
      get dead() { return dead; },
      initialState() { return guard(() => M._webrepl_state()); },
      begin() { report(api.initialState()); },   // after posting 'ready'
    };
    return api;
  }

  return { start, describe, RUNNING, WAITING, BUSY, EXITED, SLEEPING, IDLE };
});

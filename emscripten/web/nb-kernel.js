/* nb-kernel.js - the page's client of the notebook kernel (webrepl-main.c, --notebook)
 *
 * Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
 * A port of CHICKEN's nb-kernel.js (the CHICKEN Scheme WebAssembly port), with the same API.
 */

/* UMD: a CommonJS module in node (tests), the global LuaNotebookKernel
 * in the page.  No DOM: it only needs a Worker-like object running
 * repl-worker.js.
 *
 *   const k = LuaNotebookKernel.create({
 *     createWorker,   () => Worker-like (postMessage, terminate, onmessage, onerror)
 *     getModule,      () => Promise<WebAssembly.Module> (optional)
 *     args,           () => the settings' lua arguments, a string or a list
 *                     (filtered by kernelArgs)
 *     init,           () => LUA_INIT for the kernel (Lua code or @file), or null
 *     files,          () => [{path, data}] written before the kernel starts
 *     sliceMs,        () => time slice in ms (optional)
 *     watchdogMs,     a Stop not answered for this long kills the kernel (3000)
 *     stopOnError,    a cell that does not end "ok" cancels the queue (true)
 *     schedule,       f => run f soon; acks are batched per call (default
 *                     requestAnimationFrame, else setTimeout 0)
 *     onCell(cellId, ev), onState(state, info), onLog(kind, text) });
 *
 * The kernel is a web module of its own, "lua --notebook [-W] [-E] [-l
 * mod]..." (see webrepl-main.c), started lazily, one cell at a time:
 * run() queues, and the next cell is sent (as the request "run RID
 * In[N]\nSOURCE") only after the kernel reported "done" for the last.
 * Its events come as JSON lines on fd 3; fds 1 and 2 are the cell's
 * stdout and stderr, and fd 4 (the console's prompts) is ignored.
 *
 * Per run(), onCell gets, in this order,
 *   queued {position} -> start {count, name} ->
 *     (stream {name, text} | display {mime, data, id, size} | clear | input {waiting})*
 *     -> done {status, count, ms, wallMs, values, error, code, reason, message}
 * or queued -> cancelled {reason}; run() resolves with the done or
 * cancelled event and never rejects.  A display has a size when its
 * data was too large to send (the page shows no more than 4 MB): the
 * number of bytes, and data is empty.  done.status is ok, error,
 * incomplete or interrupted (from the kernel), or killed, exited or
 * crashed (the kernel went away).  values is a list of strings (the
 * results as K.repr formats them) or null; error is the kernel's
 * ErrorObj {text, kind, line, chain, form, traceback}.
 *
 * onState(state, {queued, current, version, arch, reason}): off,
 * starting, idle, busy, sleeping, input (the cell reads stdin), dead
 * (exited, crashed or killed; the next run() respawns it) or
 * unavailable.
 *
 * onLog(kind, text): stdout and stderr outside any cell (the output of
 * LUA_INIT, -e and -l code, and their "lua: " errors), init (how
 * LUA_INIT went), display (a display outside a cell, rid 0, which has no
 * place to go; text/plain is logged as stdout), kernel (restarts and
 * exits) and protocol (anything the kernel sent that makes no sense). */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LuaNotebookKernel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // webrepl.h's states (RUNNING 0 and BUSY 2 need nothing here)
  const WAITING = 1, SLEEPING = 4, IDLE = 5;
  // after input, how long the stdin box waits for the kernel to read again
  const INPUT_HIDE_MS = 250;

  // The Arguments setting as words: white space separates, '…' and "…"
  // quote (LuaPage.splitArgs's rules, for when the page gives a string).
  function splitArgs(s) {
    const out = [];
    let cur = null, quote = null;
    for (const c of String(s == null ? '' : s)) {
      if (quote) { if (c === quote) quote = null; else cur += c; }
      else if (c === '"' || c === '\'') { quote = c; if (cur === null) cur = ''; }
      else if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } }
      else cur = (cur === null ? '' : cur) + c;
    }
    if (cur !== null) out.push(cur);
    return out;
  }

  // The lua options that make sense for the kernel: -W and -E, and
  // -l mod, -lmod or -l g=mod (which run before the first cell, as for
  // the console).  Everything else is dropped: -e and its statement, -i,
  // -v, unknown options, and a script with its arguments (after "--" or
  // not), which the kernel refuses.
  function kernelArgs(s) {
    const a = Array.isArray(s) ? s.map(String) : splitArgs(s);
    const kept = [];
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') break;
      if (x === '-W' || x === '-E') kept.push(x);
      else if (x === '-l') { if (i + 1 < a.length) kept.push(x, a[++i]); }
      else if (/^-l./.test(x)) kept.push(x);
      else if (x === '-e') i++;
    }
    return kept;
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const reasonOf = e => String((e && (e.reason || e.message)) || e || 'unknown error');
  const noErrorResult = {
    text: 'the cell ended without reporting a result',
    kind: [], line: null, chain: [], form: null, traceback: null,
  };

  function create(opts) {
    const o = Object.assign({ watchdogMs: 3000, stopOnError: true }, opts);
    const schedule = o.schedule ||
      (typeof requestAnimationFrame === 'function' ? f => requestAnimationFrame(() => f())
                                                   : f => setTimeout(f, 0));
    const call = (f, ...a) => { try { if (f) f(...a); } catch (e) { console.error(e); } };
    const onCell = (id, ev) => call(o.onCell, id, ev);
    const log = (kind, text) => call(o.onLog, kind, text);
    const get = (f, dflt) => { if (!f) return dflt; const v = f(); return v === undefined ? dflt : v; };

    let w = null, gen = 0, ready = false, hello = false, info = null;
    let state = 'off', reason = null, lastState = '';
    let queue = [], current = null, execCount = 0;
    // start()'s promise: one per startup, kept across a respawn before hello
    let startP = null, startRes = null, startRej = null;
    function settleStart(err) {
      const f = err ? startRej : startRes;
      startP = startRes = startRej = null;
      if (f) f(err);
    }
    let carry = '', ackBytes = 0, ackPending = false;
    let watchdog = null, disposed = false;

    function emitState() {
      const key = state + '|' + queue.length + '|' + (current ? current.cellId : '') + '|' + reason;
      if (key === lastState) return;
      lastState = key;
      call(o.onState, state, { queued: queue.length, current: current ? current.cellId : null,
                               version: info ? info.version : null, arch: info ? info.arch : null, reason });
    }
    function setState(s, why) { state = s; reason = why || null; emitState(); }

    function post(m) { if (w) w.postMessage(m); }
    function kill() {
      gen++;                            // later messages of this worker are ignored
      if (w) { try { w.terminate(); } catch (e) { /* gone */ } }
      w = null; ready = false; hello = false; carry = ''; ackBytes = 0;
      disarm();
    }

    // ---- terminal events

    function cancelQueue(why) {
      const q = queue;
      queue = [];
      for (const e of q) {
        const ev = { type: 'cancelled', reason: why };
        onCell(e.cellId, ev);
        e.resolve(ev);
      }
      emitState();
    }

    // the current cell ends; FIELDS from the kernel's done or synthesized
    function finish(fields, fromKernel) {
      const cur = current;
      current = null;
      disarm();
      showInput(cur, false);
      const ev = Object.assign({ type: 'done', count: cur.count, ms: null,
                                 wallMs: Math.round(now() - cur.t0), values: null, error: null }, fields);
      delete ev.ev; delete ev.rid;
      onCell(cur.cellId, ev);
      cur.resolve(ev);
      if (fromKernel && ev.status !== 'ok' && o.stopOnError) cancelQueue('previous cell failed');
      return ev;
    }

    // ---- the worker

    function spawn() {
      kill();
      const g = gen;
      execCount = 0;
      info = null;
      if (!startP) {
        startP = new Promise((res, rej) => { startRes = res; startRej = rej; });
        startP.catch(() => {});         // run() does not need it
      }
      const p = startP;
      setState('starting');
      Promise.resolve()
        .then(() => (o.getModule ? o.getModule() : undefined))
        .then(wasmModule => {
          if (g !== gen || disposed) return;
          const worker = o.createWorker();
          w = worker;
          worker.onmessage = e => { if (g === gen) message(e.data); };
          worker.onerror = e => {
            if (g !== gen) return;
            if (e && e.preventDefault) e.preventDefault();
            const why = reasonOf(e);
            if (ready) gone('crashed', why); else unavailable(why);
          };
          const init = get(o.init, null);
          worker.postMessage({ type: 'init', args: ['--notebook', ...kernelArgs(get(o.args, ''))],
                               init: init == null || init === '' ? null : String(init),
                               files: get(o.files, []), sliceMs: get(o.sliceMs, undefined), wasmModule });
        })
        .catch(e => { if (g === gen) unavailable(reasonOf(e)); });
      return p;
    }

    function unavailable(why) {
      kill();
      setState('unavailable', why);
      cancelQueue('kernel unavailable');
      settleStart({ reason: why });
    }

    // exit or crash (or a worker error after ready)
    function gone(how, detail) {
      const wasHello = hello;
      kill();
      const why = how === 'exited' ? 'kernel exited (code ' + detail + ')' : 'kernel crashed: ' + detail;
      if (current) finish(how === 'exited' ? { status: 'exited', code: detail }
                                           : { status: 'crashed', message: String(detail) });
      cancelQueue(how === 'exited' ? 'kernel exited' : 'kernel crashed');
      setState('dead', why);
      log('kernel', why);
      if (!wasHello) settleStart({ reason: why });
    }

    function message(m) {
      if (watchdog) arm();              // any sign of life
      switch (m.type) {
      case 'ready': ready = true; break;
      case 'output':
        ackBytes += m.text.length;
        if (!ackPending) {
          ackPending = true;
          const g = gen;
          schedule(() => {
            ackPending = false;
            if (g === gen && ackBytes) post({ type: 'ack', bytes: ackBytes });
            ackBytes = 0;
          });
        }
        if (m.fd === 3) events(m.text);
        else if (m.fd !== 1 && m.fd !== 2) break;    // fd 4: the console's prompts
        else if (current) onCell(current.cellId, { type: 'stream', name: m.fd === 2 ? 'stderr' : 'stdout', text: m.text });
        else log(m.fd === 2 ? 'stderr' : 'stdout', m.text);
        break;
      case 'state': workerState(m.state); break;
      case 'exit': gone('exited', m.code); break;
      case 'crash': gone('crashed', m.message); break;
      }
    }

    // A state message reports the end of a slice, and the worker sends
    // one after every slice, also one that ran nothing (input or Stop
    // that reached a kernel at IDLE).  States that come before the
    // current cell's "start" event are those of earlier slices: the
    // kernel has not read the cell's request yet.  (The worker flushes
    // the output of a slice before its state, so "start" comes first.)
    function workerState(st) {
      if (!hello) return;               // startup: stays "starting"
      if (!current) {
        if (st === IDLE) setState('idle');
        return;
      }
      if (!current.started) return;
      if (st === IDLE) {                // impossible: done precedes IDLE
        log('protocol', 'the kernel went idle without reporting the end of the cell');
        finish({ status: 'error', error: noErrorResult }, true);
        setState('idle');
        pump();
        return;
      }
      const waiting = st === WAITING;
      current.waiting = waiting;
      // just after input() the box stays up while the kernel may read again
      if (waiting || !current.hideTimer) showInput(current, waiting);
      setState(waiting ? 'input' : st === SLEEPING ? 'sleeping' : 'busy');
    }

    // the cell's stdin box: CUR.shown is what onCell was last told
    function showInput(cur, on) {
      if (cur.hideTimer) { clearTimeout(cur.hideTimer); cur.hideTimer = null; }
      if (cur.shown === on) return;
      cur.shown = on;
      onCell(cur.cellId, { type: 'input', waiting: on });
    }

    function events(text) {
      const lines = (carry + text).split('\n');
      carry = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { log('protocol', line); continue; }
        if (ev && typeof ev === 'object') event(ev); else log('protocol', line);
      }
    }

    function display(ev) {
      const d = { type: 'display', mime: String(ev.mime), data: String(ev.data == null ? '' : ev.data),
                  id: ev.id == null ? null : String(ev.id) };
      if (Number.isInteger(ev.size) && ev.size >= 0) d.size = ev.size;
      return d;
    }

    function checkRid(ev) {
      if (!current || ev.rid !== current.rid)
        log('protocol', ev.ev + ' for rid ' + ev.rid + ', current ' + (current ? current.rid : 'none'));
    }

    function event(ev) {
      switch (ev.ev) {
      case 'hello':
        if (hello && current) {         // the kernel started over under a cell
          log('protocol', 'hello during a cell');
          finish({ status: 'error', error: noErrorResult }, true);
        }
        hello = true;
        info = { proto: ev.proto, version: ev.version, arch: ev.arch };
        setState('idle');
        settleStart();
        pump();
        break;
      case 'init':
        log('init', ev.status === 'ok' ? 'LUA_INIT ran' : (ev.error && ev.error.text) || 'LUA_INIT failed');
        break;
      case 'start':
        checkRid(ev);
        if (current && ev.rid === current.rid) current.started = true;
        break;
      case 'display':
      case 'clear':
        if (current && ev.rid) {
          if (ev.rid !== current.rid) checkRid(ev);
          onCell(current.cellId, ev.ev === 'clear' ? { type: 'clear' } : display(ev));
        } else if (!ev.rid) {           // LUA_INIT, -l: no cell to show it in
          if (ev.ev === 'clear') break;
          const d = display(ev);
          if (d.mime === 'text/plain' && d.size == null) log('stdout', d.data + '\n');
          else log('display', d.mime + ' output not shown (' + (d.size != null ? d.size : d.data.length) + ' bytes)');
        } else log('protocol', ev.ev + ' outside a cell' + (ev.mime ? ' (' + ev.mime + ')' : ''));
        break;
      case 'done':
        if (!current) { log('protocol', 'done for rid ' + ev.rid + ' without a current cell'); break; }
        if (ev.rid !== current.rid) checkRid(ev);
        finish(ev, true);
        setState('idle');
        pump();
        break;
      case 'pong': break;
      case 'bad-request':
        log('protocol', 'bad request: ' + ev.text);
        if (current && !current.started) {      // the cell never starts
          finish({ status: 'error', error: noErrorResult }, true);
          setState('idle');
          pump();
        }
        break;
      default: log('protocol', JSON.stringify(ev));
      }
    }

    function pump() {
      if (!hello || current || !queue.length || disposed) return;
      const q = queue.shift();
      const count = ++execCount, rid = count, name = 'In[' + count + ']';
      current = { cellId: q.cellId, rid, count, resolve: q.resolve, t0: now(), waiting: false,
                  shown: false, hideTimer: null, started: false };
      // lone surrogates would not survive the trip as UTF-8
      const src = typeof q.source.toWellFormed === 'function' ? q.source.toWellFormed() : q.source;
      post({ type: 'request', text: 'run ' + rid + ' ' + name + '\n' + src });
      onCell(q.cellId, { type: 'start', count, name });
      setState('busy');
    }

    function spawnIfNeeded() {
      if (state === 'dead') log('kernel', 'kernel restarted');
      if (state === 'off' || state === 'unavailable' || state === 'dead') return spawn();
      return startP || Promise.resolve();
    }

    // ---- the Stop watchdog

    // Armed by stop() and again by every message: it fires when the
    // worker sent nothing for watchdogMs, whatever the last state it
    // reported.  A kernel that sleeps reports every slice at least, one
    // that waits for input answers the interrupt at once, but the slice
    // that wakes up or gets the input may run into a long C function (a
    // string.rep of a gigabyte, a table.sort whose comparator loops)
    // without reporting anything.
    function disarm() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }
    function arm() {
      disarm();
      watchdog = setTimeout(() => {
        watchdog = null;
        if (!current) return;
        const why = 'kernel did not respond to Stop and was restarted';
        kill();
        finish({ status: 'killed', reason: 'unresponsive' });
        cancelQueue('stopped');
        log('kernel', why);
        spawn();
      }, o.watchdogMs);
    }

    // ---- the API

    const api = {
      start() {
        if (disposed) return Promise.reject({ reason: 'disposed' });
        if (hello) return Promise.resolve();
        if (state === 'starting' && startP) return startP;
        return spawnIfNeeded();
      },
      run(cellId, source) {
        return new Promise(resolve => {
          if (disposed) {
            const ev = { type: 'cancelled', reason: 'disposed' };
            onCell(cellId, ev);
            resolve(ev);
            return;
          }
          queue.push({ cellId, source: String(source), resolve });
          onCell(cellId, { type: 'queued', position: queue.length });
          spawnIfNeeded();
          emitState();
          pump();
        });
      },
      runMany(cells) { return Promise.all(cells.map(c => api.run(c.cellId, c.source))); },
      cancel(cellId) {
        const keep = [];
        for (const e of queue) {
          if (e.cellId === cellId) {
            const ev = { type: 'cancelled', reason: 'removed' };
            onCell(e.cellId, ev);
            e.resolve(ev);
          } else keep.push(e);
        }
        queue = keep;
        emitState();
      },
      stop() {
        if (current && w) {
          post({ type: 'interrupt' });
          arm();
        }
        cancelQueue('stopped');
      },
      // While the kernel reads, and just after (more input may follow
      // before it reads again).  The cell is busy until the kernel says
      // otherwise, which may be never: the slice that gets the input may
      // run into a long C function.  The stdin box goes unless the kernel
      // waits again soon.
      input(text, eof = false) {
        const cur = current;
        if (!cur || !(cur.waiting || cur.shown)) return;
        post({ type: 'input', text: String(text), eof: !!eof });
        if (!cur.waiting) return;
        cur.waiting = false;
        setState('busy');
        if (!cur.hideTimer && cur.shown)
          cur.hideTimer = setTimeout(() => { cur.hideTimer = null; if (current === cur && !cur.waiting) showInput(cur, false); },
                                     INPUT_HIDE_MS);
      },
      restart() {
        if (disposed) return Promise.reject({ reason: 'disposed' });
        const was = state;
        kill();
        if (current) finish({ status: 'killed', reason: 'restart' });
        cancelQueue('restart');
        if (was !== 'off' && was !== 'unavailable') log('kernel', 'kernel restarted');
        return spawn();
      },
      // (the worker queues it until it is ready)
      writeFile(path, data) { post({ type: 'writeFile', id: 0, path, data }); },
      dispose() {
        if (disposed) return;
        disposed = true;
        kill();
        if (current) finish({ status: 'killed', reason: 'disposed' });
        cancelQueue('disposed');
        settleStart({ reason: 'disposed' });
        setState('off');
      },
      get state() { return state; },
      get current() { return current ? current.cellId : null; },
      get queueLength() { return queue.length; },
      get execCount() { return execCount; },
      get info() { return info; },
    };
    return api;
  }

  return { create, kernelArgs, splitArgs };
});

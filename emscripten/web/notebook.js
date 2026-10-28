/* notebook.js - the Notebook tab of the Lua page (index.html)
 *
 * Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
 * A port of CHICKEN's notebook.js (the CHICKEN Scheme WebAssembly port): the same behaviours,
 * limits and keys, for Lua.
 */

/* The Notebook tab: cells of Lua and Markdown, run by a second web module
 * (the notebook kernel, "lua --notebook", through nb-kernel.js), separate
 * from the Console's.  No dependencies.
 *
 * - repl.js provides window.LuaPage (settings, storage, the compiled
 *   .wasm, uploads) and the shell: index.html's empty #nb-toolbar (in the
 *   header bar) and #nb-panel, which this file fills; notebook-lib.js the
 *   markdown renderer, the markup sanitizer, the Lua highlighter and
 *   scanner and the file formats; nb-kernel.js the kernel client;
 *   notebook.css the styles.
 * - The kernel starts on the first visit to the tab (or the first run).
 *   A cell is compiled as "return SOURCE;" first, then as SOURCE, then
 *   with its last lines as an expression (webrepl-main.c): its values
 *   come back formatted by notebook.lua's K.repr, one "⇒" line each, and
 *   a display object (or an <svg> tree) as a rich output.  Globals live
 *   on from cell to cell, locals do not.
 * - Kernel output is queued per cell and rendered once per animation
 *   frame; while a cell runs, its outputs keep their first and last 512
 *   KB of streams and 500 outputs (a note says how much was left out).
 * - Code cells are colored by notebook-lib.js's highlighter, in an
 *   overlay behind each editor, painted as cells come into view.  Enter
 *   indents as the line before says (a block or bracket left open: two
 *   spaces more), and end, until, else, elseif or a closing bracket typed
 *   at the start of a line goes back one level.
 * - Rich outputs (HTML, SVG, Markdown) are rebuilt from an allowlist by
 *   notebook-lib.js; no untrusted string ever reaches innerHTML.
 * - The notebook is saved to the page's storage (LuaPage.store, key
 *   "notebook", debounced, and on pagehide, on hiding and on Ctrl+S),
 *   outputs capped at 64 KB per cell; it can be exported as .lua
 *   (percent format), .json (with outputs) or .html (a static page of
 *   what the notebook shows). */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const panel = $('nb-panel'), toolbar = $('nb-toolbar');
  if (!panel || !toolbar) return;
  const P = window.LuaPage, L = window.LuaNotebookLib, K = window.LuaNotebookKernel;

  const STREAM_HEAD = 512 * 1024, STREAM_TAIL = 512 * 1024, OUT_HEAD = 500, OUT_TAIL = 500;
  const VALUE_MAX = 64 * 1024, VALUE_LINES = 30;
  const DISPLAY_MAX = 4 * 1024 * 1024;
  const SAVE_OUT_MAX = 64 * 1024, SAVE_MAX = 2 * 1024 * 1024, SAVE_KEY = 'notebook', STORE_PREFIX = 'lua-web.';
  const TRASH_MAX = 20, LOG_LINES = 500;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---- small DOM helpers

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }
  // an icon: [tag, attributes] shapes in a 24x24 box, outlined or FILLED
  function svgIcon(shapes, filled) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (filled) s.setAttribute('fill', 'currentColor');
    else {
      s.setAttribute('fill', 'none');
      s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', '2');
      s.setAttribute('stroke-linecap', 'round');
      s.setAttribute('stroke-linejoin', 'round');
    }
    for (const [tag, attrs] of shapes) {
      const e = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      s.appendChild(e);
    }
    return s;
  }
  const path = d => ['path', { d }];
  const ICONS = {
    run: [[path('M8 5.5v13a1 1 0 0 0 1.53.85l10.4-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z')], true],
    runAll: [[path('M4 5.5v13a1 1 0 0 0 1.5.86L13 14.5V18.5a1 1 0 0 0 1.5.86l8-6.5a1 1 0 0 0 0-1.72l-8-6.5A1 1 0 0 0 13 5.5v4L5.5 4.64A1 1 0 0 0 4 5.5z')], true],
    stop: [[['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]], true],
    restart: [[path('M3 12a9 9 0 1 0 3-6.7'), path('M3 4v5h5')]],
    restartRun: [[path('M3 12a9 9 0 1 0 3-6.7'), path('M3 4v5h5'), path('M10 9v6l5-3z')]],
    add: [[path('M12 5v14M5 12h14')]],
    more: [[['circle', { cx: 5, cy: 12, r: 1.8 }], ['circle', { cx: 12, cy: 12, r: 1.8 }], ['circle', { cx: 19, cy: 12, r: 1.8 }]], true],
    upload: [[path('M12 15V3'), path('M7 8l5-5 5 5'), path('M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4')]],
    keys: [[['rect', { x: 2, y: 6, width: 20, height: 12, rx: 2 }], path('M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10')]],
    settings: [[path('M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12'), ['circle', { cx: 16, cy: 6, r: 2 }],
                ['circle', { cx: 10, cy: 12, r: 2 }], ['circle', { cx: 18, cy: 18, r: 2 }]]],
    up: [[path('M6 15l6-6 6 6')]],
    down: [[path('M6 9l6 6 6-6')]],
    code: [[path('M9 7l-5 5 5 5M15 7l5 5-5 5')]],
    text: [[path('M5 6h14M5 11h14M5 16h9')]],
    del: [[path('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3')]],
  };
  const icon = name => svgIcon(ICONS[name][0], ICONS[name][1]);
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const fmtNum = n => n.toLocaleString('en-US');
  const isTouch = !!(P && P.touch);
  const countLines = s => {
    if (P && P.countLines) return P.countLines(s);
    let n = 0;
    for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
    return n;
  };
  const kbd = (...keys) => {
    const out = [];
    keys.forEach((k, i) => { if (i) out.push('+'); out.push(h('kbd', { text: k })); });
    return out;
  };

  // ---- the DOM: the toolbar in the header bar, the panel, the dialog

  // a toolbar button: ID, ICON, LABEL (shown from 640 px), TITLE; WIDE:
  // only from 640 px (the File menu has its action too)
  function tbButton(id, iconName, label, title, wide, danger) {
    return h('button', { class: 'btn ghost' + (danger ? ' danger' : '') + (wide ? ' nb-wide' : ''), id, type: 'button',
                         'aria-label': label, title }, icon(iconName), h('span', { class: 'label', text: label }));
  }
  const menuItem = (act, label, key) => h('button', { type: 'button', role: 'menuitem', tabindex: '-1', 'data-act': act },
                                          label, key ? h('kbd', { text: key }) : null);
  toolbar.replaceChildren(
    tbButton('nb-run', 'run', 'Run', 'Run the selected cell and select the next one (Shift+Enter)'),
    tbButton('nb-run-all', 'runAll', 'Run all', 'Run every code cell, top to bottom'),
    tbButton('nb-stop', 'stop', 'Stop', 'Interrupt the running cell and cancel the queue (i, i)', false, true),
    tbButton('nb-restart', 'restart', 'Restart', 'Start a fresh notebook interpreter (0, 0)'),
    tbButton('nb-restart-run', 'restartRun', 'Restart & run all', 'Start a fresh interpreter and run every cell', true),
    tbButton('nb-add-code', 'add', 'Cell', 'Insert a code cell below the selected one (b)'),
    tbButton('nb-upload-btn', 'upload', 'Upload', 'Copy files into the interpreter\'s home directory', true),
    tbButton('nb-keys-btn', 'keys', 'Shortcuts', 'Keyboard shortcuts (?)', true),
    tbButton('nb-settings', 'settings', 'Settings', 'Settings', true),
    h('button', { class: 'btn ghost', id: 'nb-more', type: 'button', 'aria-label': 'File', 'aria-haspopup': 'menu',
                  'aria-expanded': 'false', 'aria-controls': 'nb-menu', title: 'Export, import and more' },
      icon('more'), h('span', { class: 'label', text: 'File' })),
    h('div', { class: 'nb-menu', id: 'nb-menu', role: 'menu', 'aria-label': 'Notebook file and more', hidden: true },
      menuItem('export-lua', 'Export .lua'), menuItem('export-json', 'Export .json'), menuItem('export-html', 'Export .html'),
      menuItem('import', 'Import…'), menuItem('new', 'New notebook'), menuItem('example', 'Example notebook'),
      h('div', { role: 'separator' }),
      menuItem('add-text', 'Add text cell'), menuItem('restart-run', 'Restart & run all'),
      menuItem('clear-all', 'Clear all outputs'),
      h('div', { role: 'separator' }),
      menuItem('upload', 'Upload files'), menuItem('settings', 'Settings'), menuItem('keys', 'Keyboard shortcuts', '?')),
    h('input', { type: 'file', id: 'nb-file', accept: '.lua,.txt,.json', hidden: true }),
    h('input', { type: 'file', id: 'nb-upload', multiple: true, hidden: true }),
    h('span', { id: 'nb-status', class: 'pill', 'data-state': 'off' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { id: 'nb-status-text', role: 'status', text: 'kernel not started' })));

  panel.replaceChildren(
    h('div', { class: 'nb' },
      h('div', { class: 'nb-head' },
        h('input', { class: 'nb-title', id: 'nb-title', 'aria-label': 'Notebook title', value: 'Untitled', maxlength: '200',
                     spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' }),
        h('span', { class: 'nb-meta' }, h('span', { class: 'nb-info', id: 'nb-info' }))),
      h('div', { class: 'notice', id: 'nb-notice', hidden: true },
        h('span', { id: 'nb-notice-text' }),
        h('button', { class: 'btn primary', id: 'nb-notice-action', type: 'button', hidden: true, text: 'OK' }),
        h('button', { class: 'btn', id: 'nb-notice-alt', type: 'button', hidden: true, text: 'Cancel' }),
        h('button', { class: 'btn ghost x', id: 'nb-notice-close', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', text: '✕' })),
      h('details', { class: 'nb-log', id: 'nb-log', hidden: true },
        h('summary', { id: 'nb-log-summary', text: 'Kernel messages' }),
        h('pre', { class: 'codebox log', id: 'nb-log-text', tabindex: '0', 'aria-labelledby': 'nb-log-summary' })),
      h('ol', { class: 'nb-cells', id: 'nb-cells', 'aria-label': 'Notebook cells' }),
      h('div', { class: 'nb-add' },
        h('button', { class: 'btn', id: 'nb-end-code', type: 'button', text: '+ Code' }),
        h('button', { class: 'btn', id: 'nb-end-text', type: 'button', text: '+ Text' })),
      h('p', { class: 'hints', id: 'nb-keys' }, ...kbd('Shift', 'Enter'), ' runs a cell and moves on, ', ...kbd('Ctrl', 'Enter'),
        ' runs it in place, ', ...kbd('Esc'), ' then ', ...kbd('?'), ' lists every shortcut. Globals live on from cell to cell, ' +
        'locals do not. The notebook is saved in this browser; File exports it as .lua, .json or .html.')),
    h('div', { class: 'sr-only', id: 'nb-live', 'aria-live': 'polite' }),
    h('div', { class: 'nb-toast', id: 'nb-toast', role: 'status', hidden: true },
      h('span', { id: 'nb-toast-text' }), h('button', { class: 'btn', id: 'nb-toast-action', type: 'button', hidden: true, text: 'Undo' })));

  {
    const keys = rows => h('dl', null, ...rows.flatMap(([k, d]) => [h('dt', null, ...k), h('dd', { text: d })]));
    const or = (a, b) => [...a, ' / ', ...b];
    document.body.appendChild(h('dialog', { id: 'nb-shortcuts', 'aria-labelledby': 'nb-shortcuts-title' },
      h('form', { method: 'dialog' },
        h('h2', { id: 'nb-shortcuts-title', text: 'Notebook shortcuts' }),
        h('div', { class: 'keys' },
          h('section', null,
            h('h3', { text: 'Running (both modes)' }),
            keys([[kbd('Shift', 'Enter'), 'Run, select the next cell'],
                  [kbd('Ctrl', 'Enter'), 'Run, stay'],
                  [kbd('Alt', 'Enter'), 'Run, insert a cell below'],
                  [kbd('Ctrl', 'C'), 'Stop (when nothing is selected)'],
                  [kbd('Ctrl', 'S'), 'Save now']]),
            h('h3', { text: 'Editing a cell' }),
            keys([[kbd('Esc'), 'Command mode'],
                  [kbd('Enter'), 'New line, indented as the block needs'],
                  [or(kbd('Tab'), kbd('Shift', 'Tab')), 'Indent / dedent (in an empty cell: move the focus)'],
                  [[...kbd('↑'), ' ', ...kbd('↓')], 'At the first or last line: previous or next cell'],
                  [[...kbd('Alt', '↑'), ' ', ...kbd('↓')], 'Move the cell']])),
          h('section', null,
            h('h3', { text: 'Command mode' }),
            keys([[kbd('Enter'), 'Edit the cell'],
                  [[...kbd('Esc'), ' ', ...or(kbd('Tab'), kbd('Shift', 'Tab'))], 'Leave the cell: next / previous'],
                  [[...kbd('↑'), ' ', ...kbd('↓'), ' or ', ...kbd('k'), ' ', ...kbd('j')], 'Select a cell'],
                  [[...kbd('Home'), ' ', ...kbd('End')], 'First or last cell'],
                  [or(kbd('a'), kbd('b')), 'Insert a cell above / below'],
                  [[...kbd('d'), ' ', ...kbd('d')], 'Delete the cell'],
                  [kbd('z'), 'Undo a delete'],
                  [or(kbd('m'), kbd('y')), 'Make it text / code'],
                  [kbd('o'), 'Hide or show the output'],
                  [[...kbd('i'), ' ', ...kbd('i')], 'Interrupt'],
                  [[...kbd('0'), ' ', ...kbd('0')], 'Restart the kernel'],
                  [kbd('?'), 'This list']]))),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', value: 'close', type: 'submit', text: 'Close' })))));
  }

  const cellsEl = $('nb-cells');
  const statusEl = $('nb-status'), statusText = $('nb-status-text');

  function fail(msg) {
    $('nb-notice-text').textContent = msg;
    $('nb-notice').hidden = false;
    for (const id of ['nb-run', 'nb-run-all', 'nb-stop', 'nb-restart', 'nb-restart-run']) { const b = $(id); if (b) b.disabled = true; }
    const rr = document.querySelector('#nb-menu [data-act="restart-run"]');
    if (rr) rr.setAttribute('aria-disabled', 'true');
    statusEl.dataset.state = 'error';
    statusText.textContent = 'unavailable';
  }
  if (!P || !L) { fail('The notebook could not start: a page script did not load. Reload the page.'); return; }

  // ---- the notebook model

  // cell: {id, type: 'code'|'markdown', source, count, outputs, status,
  //        stale, ranSource, editing, collapsed}; outputs are the saved
  //        kinds ({k:'stream'|'value'|'display'|'error'|'note', ...}),
  //        with their DOM nodes in the views map
  const nb = { title: 'Untitled', created: null, modified: null, cells: [] };
  const views = new Map();              // cell id -> view
  let selectedId = null;
  const trash = [];
  let outSeq = 0;

  const byId = id => nb.cells.find(c => c.id === id);
  const indexOf = cell => nb.cells.indexOf(cell);
  // The kernel session: counts start again at 1 in each, so In[N] names
  // a cell of one session only.  A cell's gen is the session it last ran
  // in (null: restored or imported, from one earlier session).
  let session = 1;
  // the cell that ran as In[N] in session GEN (for the links of a traceback)
  const byCount = (n, gen) => nb.cells.find(c => c.type === 'code' && c.count === n && c.gen === gen);

  function newCell(type, source) {
    return { id: L.newId(), type, source: source || '', count: null, outputs: [], status: 'idle',
             stale: false, ranSource: null, editing: type === 'markdown' && !source, collapsed: false,
             sources: [], rt: null, gen: null };
  }

  // ---- the kernel

  let kernel = null, kernelState = 'off', kernelUsed = false;

  function ensureKernel() {
    if (kernel) return kernel;
    if (P.unavailable || !K) return null;
    kernel = K.create({
      createWorker: () => new Worker(P.workerUrl('repl-worker.js')),   // the Console's build
      getModule: () => P.replModule(),
      args: () => (typeof P.splitArgs === 'function' ? P.splitArgs(P.settings.args) : P.settings.args),
      init: () => (String(P.settings.init || '').trim() ? P.settings.init : null),
      files: () => [...P.uploads].map(([n, d]) => ({ path: P.HOME + n, data: d })),
      sliceMs: () => P.settings.sliceMs,
      watchdogMs: 3000,
      stopOnError: true,
      schedule: f => requestAnimationFrame(f),
      onCell, onState, onLog,
    });
    return kernel;
  }
  function startKernel() {
    const k = ensureKernel();
    if (!k) return;
    k.start().catch(e => {
      // the first line: a crash's stack is in the kernel messages
      const why = String((e && (e.reason || e.message)) || e).split('\n')[0];
      showNotice('kernel', 'The notebook kernel is unavailable: ' + clip(why, 400));
    });
  }

  const STATES = {
    off: ['off', 'kernel not started'], starting: ['loading', 'starting kernel'], idle: ['ready', 'idle'],
    busy: ['running', 'running'], sleeping: ['sleeping', 'sleeping'], input: ['waiting', 'waiting for input'],
    dead: ['exited', 'kernel stopped'], unavailable: ['error', 'unavailable'],
  };
  function setStatus(key, text) {
    statusEl.dataset.state = key;
    statusEl.title = text;
    if (statusText.textContent !== text) statusText.textContent = text;
  }
  const infoLine = (version, arch) => (version || 'Lua ' + P.VERSION) + ' · ' + (arch || P.ARCH || '');
  function onState(state, info) {
    kernelState = state;
    const [key, label] = STATES[state] || ['loading', state];
    let text = label;
    if ((state === 'busy' || state === 'sleeping' || state === 'input') && info && info.queued)
      text += ' · ' + info.queued + ' queued';
    if (state === 'dead' && info && info.reason) text = clip(String(info.reason), 60);
    setStatus(key, text);
    if (state === 'unavailable')
      showNotice('kernel', 'The notebook kernel is unavailable: ' + ((info && info.reason) || 'it could not be loaded') +
                 (P.HTTP_HINT && !/HTTP/.test((info && info.reason) || '') ? ' ' + P.HTTP_HINT : ''));
    if (state === 'idle' && kernel && kernel.info) $('nb-info').textContent = infoLine(kernel.info.version, kernel.info.arch);
    updateToolbar();
  }
  function onLog(kind, text) {
    log(kind, text);
    if (kind === 'kernel') announce(text.replace(/^./, c => c.toUpperCase()));
  }

  // ---- cell events from the kernel (batched per frame)

  const dirty = new Set();
  let frame = 0;
  function queueOp(cell, op) {
    (cell.ops || (cell.ops = [])).push(op);
    dirty.add(cell);
    if (!frame) frame = requestAnimationFrame(flush);
  }
  function flush() {
    frame = 0;
    for (const cell of dirty) flushCell(cell);
    dirty.clear();
  }
  function flushCell(cell) {
    const ops = cell.ops;
    if (!ops || !ops.length) return;
    cell.ops = [];
    dirty.delete(cell);
    if (!views.has(cell.id)) return;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type === 'stream') {
        let text = op.text;
        while (i + 1 < ops.length && ops[i + 1].type === 'stream' && ops[i + 1].name === op.name &&
               text.length < STREAM_TAIL) text += ops[++i].text;
        appendStream(cell, op.name, text);
      } else if (op.type === 'display') addDisplay(cell, op);
      else if (op.type === 'clear') clearOutputs(cell);
    }
  }

  // the cell whose run the kernel started last, until its done: a
  // cell with its id that is another object (a notebook loaded, a
  // deletion undone) gets none of that run's events
  let startedCell = null;
  function onCell(id, ev) {
    const cell = byId(id);
    const started = startedCell && startedCell.id === id ? startedCell : null;
    if (ev.type === 'start') startedCell = cell;
    else if (ev.type === 'done' && started) startedCell = null;
    if (!cell) return;                  // deleted meanwhile
    if (started && started !== cell && ev.type !== 'queued' && ev.type !== 'cancelled' && ev.type !== 'start') return;
    switch (ev.type) {
    case 'queued':
      if (cell.status !== 'running' && cell.status !== 'waiting') cell.status = 'queued';
      chrome(cell);
      break;
    case 'start':
      flushCell(cell);
      cell.ops = [];
      clearOutputs(cell);
      clearHighlight(cell);
      cell.status = 'running';
      cell.runCount = ev.count;
      cell.gen = session;
      cell.ranSource = cell.sources.length ? cell.sources.shift() : cell.source;
      cell.stale = false;
      kernelUsed = true;
      chrome(cell);
      break;
    case 'stream': case 'display': case 'clear':
      queueOp(cell, ev);
      break;
    case 'input':
      flushCell(cell);
      showStdin(cell, ev.waiting);
      break;
    case 'done':
      flushCell(cell);
      finish(cell, ev);
      break;
    case 'cancelled':
      cell.sources.shift();
      // a cell also running (or just ended) keeps its status: only its
      // extra run is dropped
      if (cell.status === 'queued') {
        if (ev.reason === 'removed') cell.status = cell.prevStatus || 'idle';
        else {
          cell.status = 'cancelled';
          setNote(cell, CANCEL[ev.reason] || 'Not run (' + ev.reason + ').', true);
        }
      }
      chrome(cell);
      break;
    }
    updateToolbar();
  }

  const CANCEL = {
    stopped: 'Not run: stopped.',
    'previous cell failed': 'Not run: a previous cell failed.',
    restart: 'Not run: the kernel was restarted.',
    'kernel exited': 'Not run: the kernel exited.',
    'kernel crashed': 'Not run: the kernel crashed.',
    'kernel unavailable': 'Not run: the kernel is unavailable.',
    disposed: 'Not run.',
  };

  function finish(cell, ev) {
    showStdin(cell, false);
    if (ev.count != null) cell.count = ev.count;
    else if (cell.runCount != null) cell.count = cell.runCount;
    const n = indexOf(cell) + 1;
    const e = ev.error && typeof ev.error === 'object' ? ev.error : null;
    let said = null;
    switch (ev.status) {
    case 'ok':
      cell.status = 'ok';
      addValues(cell, ev.values);
      said = 'Cell ' + n + ' finished' + (ev.values && ev.values.length ? ': ' + ev.values.join(', ') : '');
      break;
    case 'error': {
      cell.status = 'error';
      const err = Object.assign({ text: 'error', kind: [], chain: [], line: null, form: null }, e);
      addOutput(cell, { k: 'error', error: err });
      if (err.line) highlightLine(cell, err.line);
      said = 'Cell ' + n + ' failed: ' + err.text;
      break;
    }
    case 'incomplete': {
      // nothing ran: the source ends inside a statement
      cell.status = 'error';
      const text = 'Incomplete: ' + String((e && e.text) || 'the cell ends inside a statement');
      addOutput(cell, { k: 'note', text, bad: true });
      if (e && e.line) highlightLine(cell, e.line);
      said = 'Cell ' + n + ': ' + text;
      break;
    }
    case 'interrupted':
      cell.status = 'interrupted';
      addOutput(cell, { k: 'note', text: 'Interrupted.' });
      if (e && e.line) highlightLine(cell, e.line);
      said = 'Cell ' + n + ' interrupted';
      break;
    default: {                          // killed, exited, crashed
      cell.status = 'error';
      let msg;
      if (ev.status === 'exited') msg = 'Kernel exited (code ' + ev.code + '). Its state was lost; the next run starts a fresh kernel.';
      else if (ev.status === 'crashed') msg = 'Kernel crashed: ' + clip(String(ev.message || 'unknown error'), 400);
      else if (ev.reason === 'unresponsive') msg = 'The kernel did not respond to Stop and was restarted. Its state was lost.';
      else msg = 'The kernel was restarted while this cell ran.';
      addOutput(cell, { k: 'note', text: msg, bad: true });
      markStale(cell);
      said = 'Cell ' + n + ': ' + msg;
    }
    }
    chrome(cell);
    if (said) announce(clip(said, 120));
    scheduleSave();
  }

  // ---- outputs

  function clearOutputs(cell) {
    cell.outputs = [];
    cell.rt = null;
    const v = views.get(cell.id);
    if (v) v.out.textContent = '';
  }
  function addOutput(cell, o, at) {
    const v = views.get(cell.id);
    if (at != null) cell.outputs.splice(at, 0, o); else cell.outputs.push(o);
    if (!v) return o;
    const el = renderOutput(cell, o);
    els.set(o, el);
    if (at != null && at < cell.outputs.length - 1) {
      const next = els.get(cell.outputs[at + 1]);
      v.out.insertBefore(el, next || null);
    } else v.out.appendChild(el);
    return o;
  }
  const els = new WeakMap();            // output -> element
  function removeOutput(cell, o) {
    const i = cell.outputs.indexOf(o);
    if (i >= 0) cell.outputs.splice(i, 1);
    const el = els.get(o);
    if (el) el.remove();
  }
  function setNote(cell, text, transient) {
    for (const o of cell.outputs.filter(o => o.k === 'note' && o.transient)) removeOutput(cell, o);
    if (text) addOutput(cell, { k: 'note', text, transient });
  }

  function renderOutput(cell, o) {
    switch (o.k) {
    case 'stream': {
      const pre = h('pre', { class: 'nb-stream ' + o.name });
      const t = document.createTextNode(o.text);
      pre.appendChild(t);
      o._t = t;
      return pre;
    }
    case 'value': return renderValue(o.text);
    case 'note': return h('p', { class: 'nb-note' + (o.bad ? ' bad' : ''), text: o.text, hidden: o.text ? null : '' });
    case 'error': return renderError(cell, o.error);
    case 'display': return renderDisplay(cell, o);
    }
    return h('p', { class: 'nb-note', text: 'unsupported output' });
  }

  // While a cell runs, its outputs are its first STREAM_HEAD characters
  // of streams and OUT_HEAD outputs, a note, and then its last
  // STREAM_TAIL characters and OUT_TAIL outputs: a flood of output, or
  // of shows, would swamp the page.  (Values and errors come after.)
  function runState(cell) {
    return cell.rt || (cell.rt = { head: 0, headN: 0, tail: 0, tailN: 0, omitted: 0, omittedN: 0, note: null });
  }
  const continues = (cell, name) => {
    const last = cell.outputs[cell.outputs.length - 1];
    return !!last && last.k === 'stream' && last.name === name;
  };
  function appendRaw(cell, name, text) {
    const last = cell.outputs[cell.outputs.length - 1];
    if (continues(cell, name)) {
      last.text += text;
      if (last._t) last._t.appendData(text);
      return;
    }
    addOutput(cell, { k: 'stream', name, text });
  }
  function appendStream(cell, name, text) {
    const rt = runState(cell);
    if (!rt.note) {
      const fits = continues(cell, name) || rt.headN < OUT_HEAD;
      const room = fits ? Math.min(text.length, STREAM_HEAD - rt.head) : 0;
      if (room > 0) {
        if (!continues(cell, name)) rt.headN++;
        rt.head += room;
        appendRaw(cell, name, room < text.length ? text.slice(0, room) : text);
      }
      if (room === text.length) return;
      text = text.slice(room);
      openNote(cell, rt);
    }
    if (text.length > STREAM_TAIL) {    // never more than the tail in the page
      rt.omitted += text.length - STREAM_TAIL;
      text = text.slice(-STREAM_TAIL);
    }
    if (!continues(cell, name)) rt.tailN++;
    appendRaw(cell, name, text);
    rt.tail += text.length;
    trimTail(cell, rt);
  }
  function openNote(cell, rt) {
    rt.note = addOutput(cell, { k: 'note', text: '' });      // hidden while empty
  }
  // a display (or the note of one too large, which has an id, maybe null)
  const shown = o => o.k === 'display' || (o.k === 'note' && o.id !== undefined);
  // drops what is over the tail's budgets, from the start of the tail
  function trimTail(cell, rt) {
    let excess = rt.tail - STREAM_TAIL;
    const outs = cell.outputs;
    const i = excess > 0 || rt.tailN > OUT_TAIL ? outs.indexOf(rt.note) : -1;
    while (i >= 0 && (rt.tailN > OUT_TAIL || excess > 0)) {
      // too many outputs: the first one goes; too many characters: the
      // first stream, or its start
      const count = rt.tailN > OUT_TAIL;
      let j = i + 1;
      while (j < outs.length && !(outs[j].k === 'stream' || (count && shown(outs[j])))) j++;
      const o = outs[j];
      if (!o) break;
      if (o.k === 'stream' && !count && o.text.length > excess) {
        o.text = o.text.slice(excess);
        if (o._t) o._t.deleteData(0, excess);
        rt.tail -= excess; rt.omitted += excess;
        break;
      }
      if (o.k === 'stream') { rt.tail -= o.text.length; rt.omitted += o.text.length; excess -= o.text.length; }
      else rt.omittedN++;
      rt.tailN--;
      removeOutput(cell, o);
    }
    const parts = [];
    if (rt.omitted) parts.push(fmtNum(rt.omitted) + ' characters');
    if (rt.omittedN) parts.push(fmtNum(rt.omittedN) + (rt.omittedN === 1 ? ' output' : ' outputs'));
    const text = parts.length ? '… ' + parts.join(' and ') + ' omitted …' : '';
    if (text === rt.note.text) return;
    rt.note.text = text;
    const el = els.get(rt.note);
    if (el) { el.textContent = text; el.hidden = !text; }
  }

  // a value as K.repr wrote it (at most 64 KB): one "⇒" line (CSS), long
  // ones folded
  function renderValue(text) {
    let t = String(text), extra = null;
    if (t.length > VALUE_MAX) {
      extra = h('p', { class: 'nb-note', text: '… value clipped: ' + fmtNum(t.length - VALUE_MAX) + ' more characters' });
      t = t.slice(0, VALUE_MAX);
    }
    const pre = h('pre', { class: 'nb-value', tabindex: '-1', text: t });
    const lines = countLines(t) + 1;
    if (lines <= VALUE_LINES && !extra) return pre;
    const box = h('div', { class: 'nb-valuebox' }, pre);
    if (lines > VALUE_LINES) {
      pre.classList.add('clamped');
      const more = h('button', { class: 'btn nb-more', type: 'button', 'aria-expanded': 'false', text: 'Show all ' + fmtNum(lines) + ' lines' });
      more.addEventListener('click', () => {
        const open = pre.classList.toggle('clamped');
        more.setAttribute('aria-expanded', String(!open));
        more.textContent = open ? 'Show all ' + fmtNum(lines) + ' lines' : 'Show less';
      });
      box.appendChild(more);
    }
    if (extra) box.appendChild(extra);
    return box;
  }
  function addValues(cell, values) {
    if (!Array.isArray(values)) return;           // null: no values
    for (const v of values) addOutput(cell, { k: 'value', text: String(v) });
  }

  // The kernel's ErrorObj: the message as lua.c prints it (without the
  // traceback), and the traceback's frames in a <details>, innermost
  // first, whose "In[N]:L" go to line L of the cell that ran as In[N].
  // FORM "print": the error came from showing the cell's values.
  const WHERE = /^In\[(\d+)\]:(\d+)$/;
  function renderError(cell, e) {
    const box = h('div', { class: 'nb-error' });
    box.appendChild(h('p', { class: 'nb-error-msg' }, h('span', { class: 'tag', text: 'Error' }), String(e.text).replace(/\s+$/, '')));
    if (e.form === 'print') box.appendChild(h('p', { class: 'nb-error-form', text: 'while showing the cell\'s values' }));
    const chain = Array.isArray(e.chain) ? e.chain : [];
    if (chain.length) {
      const det = h('details', { class: 'nb-trace' }, h('summary', { text: 'Traceback (' + chain.length + ')' }));
      const ol = h('ol');
      const own = cell.count != null ? 'In[' + cell.count + ']' : null;
      for (const f of chain) {
        const where = String(f.where || ''), m = WHERE.exec(where);
        let w;
        if (m) {
          w = h('button', { class: 'where', type: 'button', title: 'Show line ' + m[2] + ' of In[' + m[1] + ']', text: where });
          w.addEventListener('click', () => {
            // (the error is from the cell's last run: its session)
            const target = byCount(Number(m[1]), cell.gen);
            if (target) selectLine(target, Number(m[2]));
            else announce('In[' + m[1] + '] is not in the notebook any more');
          });
        } else w = h('span', { class: 'where', text: where });
        const here = own && (where === own || where.startsWith(own + ':'));
        ol.appendChild(h('li', { class: here ? 'here' : null }, w, h('span', { class: 'proc', text: f.proc == null ? '' : String(f.proc) })));
      }
      det.appendChild(ol);
      box.appendChild(det);
    }
    return box;
  }

  function renderDisplay(cell, o) {
    const n = indexOf(cell) + 1;
    const div = h('div', { class: 'nb-rich', 'data-mime': o.mime });
    const data = String(o.data);
    if (data.length > DISPLAY_MAX) return h('p', { class: 'nb-note', text: tooLarge(o.mime, data.length) });
    const prefix = 'o' + (++outSeq) + '-';
    try {
      switch (o.mime) {
      case 'text/plain': div.appendChild(h('pre', { text: data })); break;
      case 'text/html': div.appendChild(L.sanitizeMarkup(data, 'html', prefix)); break;
      case 'image/svg+xml': div.appendChild(L.sanitizeMarkup(data, 'svg', prefix)); break;
      case 'text/markdown': div.appendChild(L.renderMarkdown(data, document, prefix)); break;
      case 'image/png': case 'image/jpeg': case 'image/gif': case 'image/webp': {
        const b64 = data.replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('the image data is not base64');
        div.appendChild(h('img', { src: 'data:' + o.mime + ';base64,' + b64, alt: 'Image output of cell ' + n }));
        break;
      }
      default:
        return h('p', { class: 'nb-note', text: 'unsupported output type ' + clip(String(o.mime), 60) });
      }
    } catch (e) {
      return h('p', { class: 'nb-note bad', text: 'Could not show the ' + o.mime + ' output: ' + ((e && e.message) || e) });
    }
    return div;
  }
  const tooLarge = (mime, n) => 'Output too large to show (' + (n / 1048576).toFixed(1) + ' MB of ' + mime + ').';
  function addDisplay(cell, ev) {
    const id = ev.id == null ? null : String(ev.id);
    // data too large for the kernel to send: a note (which is saved)
    const o = ev.size != null ? { k: 'note', text: tooLarge(ev.mime, ev.size), id }
      : { k: 'display', mime: ev.mime, data: ev.data, id };
    if (id != null) {
      const prev = cell.outputs.find(x => (x.k === 'display' || x.k === 'note') && x.id === id);
      if (prev) {
        const i = cell.outputs.indexOf(prev);
        removeOutput(cell, prev);
        addOutput(cell, o, i);
        return;
      }
    }
    const rt = runState(cell);
    if (!rt.note) {
      if (rt.headN < OUT_HEAD) { rt.headN++; addOutput(cell, o); return; }
      openNote(cell, rt);
    }
    rt.tailN++;
    addOutput(cell, o);
    trimTail(cell, rt);
  }

  // ---- stdin

  function showStdin(cell, on) {
    const v = views.get(cell.id);
    if (!v) return;
    if (cell.status === 'running' || cell.status === 'waiting') cell.status = on ? 'waiting' : 'running';
    chrome(cell);
    if (!on) {
      if (v.stdin) {
        // the cell, not <body>, keeps the focus of its input
        const had = v.stdin.contains(document.activeElement);
        v.stdin.hidden = true;
        if (had) select(cell.id, { focus: 'cell' });
      }
      return;
    }
    const f = stdinForm(cell, v);
    f.hidden = false;
    const n = indexOf(cell) + 1;
    announce('Cell ' + n + ' is waiting for input');
    v.stdinText.focus({ preventScroll: true });
    f.scrollIntoView({ block: 'nearest' });
  }
  function stdinForm(cell, v) {
    if (v.stdin) return v.stdin;
    const n = indexOf(cell) + 1;
    const id = 'nb-in-' + cell.id;
    const text = h('input', { class: 'nb-stdin-text', id, enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'off',
                              autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Input for cell ' + n });
    const send = h('button', { class: 'btn primary', type: 'submit', text: 'Send' });
    const eof = h('button', { class: 'btn ghost nb-eof', type: 'button', title: 'End of input (Ctrl+D)', text: 'EOF' });
    const f = h('form', { class: 'nb-stdin', hidden: true, autocomplete: 'off' }, h('label', { for: id, text: 'stdin' }), text, send, eof);
    f.addEventListener('submit', e => {
      e.preventDefault();
      if (!kernel) return;
      const s = text.value;
      text.value = '';
      queueOp(cell, { type: 'stream', name: 'stdin', text: s + '\n' });
      kernel.input(s + '\n');
    });
    const sendEof = () => { if (kernel) kernel.input('', true); text.value = ''; };
    eof.addEventListener('click', sendEof);
    text.addEventListener('keydown', e => {
      if (e.key === 'd' && (e.ctrlKey || e.metaKey) && !text.value) { e.preventDefault(); sendEof(); }
      else if (e.key === 'Escape') { e.preventDefault(); stop(); }
    });
    v.body.appendChild(f);
    v.stdin = f;
    v.stdinText = text;
    return f;
  }

  // ---- cell views

  function makeView(cell) {
    const li = h('li', { class: 'nb-cell', 'data-id': cell.id, 'data-type': cell.type, tabindex: '-1' });
    const run = h('button', { class: 'nb-run btn ghost', type: 'button' }, icon('run'));
    const count = h('span', { class: 'nb-count', 'aria-hidden': 'true' });
    const src = h('textarea', { class: 'nb-src', rows: '1', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
                                autocorrect: 'off', wrap: 'soft' });
    src.value = cell.source;
    const hl = h('div', { class: 'nb-hl', 'aria-hidden': 'true', inert: true });
    const bal = h('span', { class: 'nb-bal', 'aria-hidden': 'true', hidden: true });
    const editor = h('div', { class: 'nb-editor' }, hl, src, bal);
    const md = h('div', { class: 'nb-md' });
    const out = h('div', { class: 'nb-out', role: 'group' });
    const showOut = h('button', { class: 'btn ghost nb-hidden-out', type: 'button', hidden: true, text: 'Output hidden — show it' });
    const body = h('div', { class: 'nb-body' }, editor, md, out, showOut);
    const up = h('button', { class: 'btn ghost', type: 'button', 'data-act': 'up' }, icon('up'));
    const down = h('button', { class: 'btn ghost', type: 'button', 'data-act': 'down' }, icon('down'));
    const kind = h('button', { class: 'btn ghost', type: 'button', 'data-act': 'type' }, icon(cell.type === 'code' ? 'text' : 'code'));
    const del = h('button', { class: 'btn ghost del', type: 'button', 'data-act': 'del' }, icon('del'));
    const tools = h('div', { class: 'nb-tools', role: 'toolbar' }, up, down, kind, del);
    // the tools come before the editor, which keeps Tab for indenting
    li.append(h('div', { class: 'nb-gutter' }, run, count), tools, body);
    const v = { li, run, count, src, hl, bal, editor, md, out, showOut, body, tools, up, down, kind, del, stdin: null, stdinText: null,
                near: false, dirty: false, mark: 0, keys: null, mdSyn: false };
    views.set(cell.id, v);
    if (nearby) nearby.observe(li);

    run.addEventListener('click', () => { select(cell.id); runOne(cell, cell.type === 'markdown' ? 'cell' : null); });
    up.addEventListener('click', () => moveCell(cell, -1, 'button'));
    down.addEventListener('click', () => moveCell(cell, 1, 'button'));
    kind.addEventListener('click', () => setType(cell, cell.type === 'code' ? 'markdown' : 'code'));
    del.addEventListener('click', () => deleteCell(cell));
    showOut.addEventListener('click', () => toggleOutput(cell));
    src.addEventListener('input', e => onEdit(cell, e));
    // while an IME composes, the editor shows its own text: the browser
    // draws the composition in the text's color, over the overlay
    src.addEventListener('compositionstart', () => editor.classList.add('ime'));
    src.addEventListener('compositionend', () => { editor.classList.remove('ime'); paint(cell, true); });
    md.addEventListener('dblclick', () => editCell(cell));
    for (const o of cell.outputs) { const el = renderOutput(cell, o); els.set(o, el); out.appendChild(el); }
    if (cell.type === 'markdown') renderMd(cell);
    paint(cell);
    chrome(cell);
    return li;
  }

  // heading ids of the markdown cells, unique in the notebook
  const mdIds = new Set(), mdIdsOf = new Map();
  function releaseMdIds(cell) {
    for (const id of mdIdsOf.get(cell.id) || []) mdIds.delete(id);
    mdIdsOf.delete(cell.id);
  }
  function renderMd(cell) {
    const v = views.get(cell.id);
    if (!v) return;
    releaseMdIds(cell);
    const frag = L.renderMarkdown(cell.source, document, 'nb-h-', mdIds, true);
    mdIdsOf.set(cell.id, Array.from(frag.querySelectorAll('[id]'), el => el.id));
    v.md.replaceChildren(frag);
    v.md.classList.toggle('empty', !cell.source.trim());
    v.mdSyn = !!v.md.querySelector('code[data-syn]');
    if (v.mdSyn) paint(cell);
  }

  const STATUS_WORDS = {
    idle: null, queued: 'queued', running: 'running', waiting: 'waiting for input', ok: 'succeeded',
    error: 'failed', interrupted: 'interrupted', cancelled: 'not run',
  };
  // count, data-* attributes and labels
  function chrome(cell) {
    const v = views.get(cell.id);
    if (!v) return;
    const n = indexOf(cell) + 1, code = cell.type === 'code';
    const li = v.li;
    li.dataset.type = cell.type;
    li.dataset.status = cell.status;
    const edited = code && cell.count != null && cell.ranSource != null && cell.ranSource !== cell.source;
    if (cell.stale) li.dataset.stale = 'true'; else delete li.dataset.stale;
    if (edited) li.dataset.edited = 'true'; else delete li.dataset.edited;
    li.classList.toggle('is-editing', !!cell.editing);
    if (cell.status === 'running' || cell.status === 'waiting') li.setAttribute('aria-busy', 'true');
    else li.removeAttribute('aria-busy');
    const c = cell.status === 'running' || cell.status === 'waiting' ? '[*]' : cell.status === 'queued' ? '[…]'
      : cell.count != null ? '[' + cell.count + ']' : '[ ]';
    if (v.count.textContent !== c) v.count.textContent = c;
    let label = (code ? 'Code' : 'Text') + ' cell ' + n;
    if (code && cell.count != null) label += ', run [' + cell.count + ']';
    const w = code && STATUS_WORDS[cell.status];
    if (w) label += ', ' + w;
    if (cell.stale) label += ', from an earlier session';
    if (edited) label += ', edited since it ran';
    li.setAttribute('aria-label', label);
    v.run.setAttribute('aria-label', (code ? 'Run cell ' : 'Render cell ') + n);
    v.run.title = code ? 'Run (Shift+Enter)' : 'Render (Shift+Enter)';
    v.src.setAttribute('aria-label', code ? 'Cell ' + n + ' source (Lua)' : 'Cell ' + n + ' text (Markdown)');
    v.src.placeholder = code ? 'Lua code' : 'Markdown text';
    v.out.setAttribute('aria-label', 'Output of cell ' + n);
    v.tools.setAttribute('aria-label', 'Cell ' + n + ' actions');
    v.up.setAttribute('aria-label', 'Move cell ' + n + ' up');
    v.up.title = 'Move up (Alt+↑)';
    v.down.setAttribute('aria-label', 'Move cell ' + n + ' down');
    v.down.title = 'Move down (Alt+↓)';
    v.kind.setAttribute('aria-label', code ? 'Make cell ' + n + ' a text cell' : 'Make cell ' + n + ' a code cell');
    v.kind.title = code ? 'Make it text (m)' : 'Make it code (y)';
    v.del.setAttribute('aria-label', 'Delete cell ' + n);
    v.del.title = 'Delete (d, d)';
    v.up.disabled = n === 1;
    v.down.disabled = n === nb.cells.length;
    v.out.hidden = !!cell.collapsed;
    v.showOut.hidden = !(cell.collapsed && cell.outputs.length);
    if (v.stdinText) v.stdinText.setAttribute('aria-label', 'Input for cell ' + n);
  }
  function chromeAll() { for (const c of nb.cells) chrome(c); }

  // editors grow with their content
  function autosize(v) {
    const ta = v.src;
    if (!ta.isConnected || panel.hidden) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }
  // all at once: the heights are written, read and written again in
  // three passes, so that the page is laid out once, not once per cell
  // (5000 cells took half a minute)
  let sizeFrame = 0;
  function resizeAll() {
    if (sizeFrame) return;
    sizeFrame = requestAnimationFrame(() => {
      sizeFrame = 0;
      if (panel.hidden) return;
      const tas = [...views.values()].map(v => v.src).filter(ta => ta.isConnected);
      for (const ta of tas) ta.style.height = 'auto';
      const hs = tas.map(ta => ta.scrollHeight);
      tas.forEach((ta, i) => { ta.style.height = hs[i] + 'px'; });
    });
  }
  addEventListener('resize', resizeAll);

  let reindenting = false;
  function onEdit(cell, e) {
    const v = views.get(cell.id);
    cell.source = v.src.value;
    if (!reindenting && cell.type === 'code' && e && e.inputType === 'insertText' && e.data && e.data.length === 1)
      typedDedent(cell, v.src, e.data);
    autosize(v);
    v.mark = 0;
    paint(cell, true);
    updateBalance(cell);
    chrome(cell);
    scheduleSave();
  }
  function updateBalance(cell) {
    const v = views.get(cell.id);
    if (!v) return;
    if (cell.type !== 'code') { v.bal.hidden = true; return; }
    const t = L.balance(cell.source).text;
    v.bal.textContent = t;
    v.bal.hidden = !t;
  }

  // ---- indentation

  // The indentation a line that closes a block (end, until, else,
  // elseif, a closing bracket) gets: that of the line before it that is
  // not blank, one level less, unless that line opened the block.
  function closingIndent(text, ls) {
    for (let e = ls - 1; e >= 0;) {
      const s = text.lastIndexOf('\n', e - 1) + 1;
      const line = text.slice(s, e);
      if (line.trim()) return Math.max(0, /^[ \t]*/.exec(line)[0].length + (L.opensBlock(line) ? 2 : 0) - 2);
      e = s - 1;
    }
    return 0;
  }
  // a line (up to the caret) that starts with a closing word or bracket
  const CLOSING = /^[ \t]*(?:(?:end|until|else|elseif)(?![A-Za-z0-9_])|[)\]}])/;
  // takes the line of TA starting at LS back to its closing indentation,
  // if it is deeper; keeps the browser's undo history
  function dedentLine(ta, ls) {
    const v = ta.value, a = ta.selectionStart;
    const cur = /^[ \t]*/.exec(v.slice(ls))[0].length;
    const want = closingIndent(v, ls);
    if (cur <= want) return;
    reindenting = true;
    try {
      ta.setSelectionRange(ls, ls + cur);
      if (want) insertText(ta, ' '.repeat(want));
      else deleteText(ta);
    } finally { reindenting = false; }
    const pos = Math.max(ls + want, a - (cur - want));
    ta.setSelectionRange(pos, pos);
  }
  // typing a closing bracket at the start of a line, or the character
  // that ends a closing word there (end, until, else, elseif: "end"
  // itself could still become "ending")
  function typedDedent(cell, ta, ch) {
    const v = ta.value, a = ta.selectionStart;
    if (a !== ta.selectionEnd) return;
    const ls = v.lastIndexOf('\n', a - 1) + 1, before = v.slice(ls, a);
    if (/^[ \t]*[)\]}]$/.test(before) ||
        (!/[A-Za-z0-9_]/.test(ch) && /^[ \t]*(?:end|until|else|elseif)[^A-Za-z0-9_]$/.test(before))) {
      dedentLine(ta, ls);
      cell.source = ta.value;
    }
  }

  // The overlay behind the editor mirrors its text: in colored spans for
  // a code cell (class syn: the editor's own text is transparent), and
  // with the line of an error in a <mark>.  It is inert, so that find in
  // page does not see its text a second time.  Cells are painted when
  // they come near the visible part of the notebook, so that a big one
  // loads without building the spans (or coloring the code blocks of a
  // text cell) out of sight; a source of more than SYN_MAX characters is
  // left plain.  A code cell's overlay has a block per line, and an edit
  // replaces those of the lines that changed only (v.keys: one per line
  // shown): a big cell is not laid out anew.
  const SYN_MAX = 32 * 1024;
  const nearby = typeof IntersectionObserver === 'function' ? new IntersectionObserver(es => {
    for (const e of es) {
      const v = views.get(e.target.dataset.id);
      if (!v || v.li !== e.target) continue;
      v.near = e.isIntersecting;
      if (v.near && v.dirty) paint(byId(e.target.dataset.id));
    }
  }, { root: panel, rootMargin: '1000px 0px' }) : null;
  function lineNode(line, marked) {
    const div = document.createElement('div'), to = marked ? div.appendChild(document.createElement('mark')) : div;
    for (const [k, s] of line) {
      if (!k) { to.appendChild(document.createTextNode(s)); continue; }
      const e = to.appendChild(document.createElement('span'));
      e.className = 'syn-' + k;
      e.textContent = s;
    }
    if (marked && !line.length) to.textContent = ' ';
    return div;
  }
  function paint(cell, now) {
    const v = views.get(cell.id);
    if (!v) return;
    if (nearby && !v.near && !now) { v.dirty = true; return; }
    v.dirty = false;
    if (v.mdSyn) { v.mdSyn = false; L.colorCode(v.md, document); }
    // the editor's text: its line breaks are \n whatever the source had
    const text = v.src.value, syn = cell.type === 'code' && text.length <= SYN_MAX;
    v.editor.classList.toggle('syn', syn);
    if (syn) {
      const lines = L.highlightLines(L.highlight(text));
      if (v.mark > lines.length) v.mark = 0;
      const keys = lines.map((l, k) => (k + 1 === v.mark ? '!' : '') + l.map(p => p[0] + '\u0001' + p[1]).join('\u0002'));
      const old = v.keys || [];
      if (!v.keys) v.hl.textContent = '';
      let p = 0, q = 0;
      while (p < old.length && p < keys.length && old[p] === keys[p]) p++;
      while (q < old.length - p && q < keys.length - p && old[old.length - 1 - q] === keys[keys.length - 1 - q]) q++;
      // siblings, not childNodes[k]: removing through that index is quadratic in Firefox
      let node = v.hl.childNodes[p] || null;
      for (let k = p; k < old.length - q; k++) { const next = node.nextSibling; node.remove(); node = next; }
      const frag = document.createDocumentFragment();
      for (let k = p; k < keys.length - q; k++) frag.appendChild(lineNode(lines[k], k + 1 === v.mark));
      v.hl.insertBefore(frag, node);
      v.keys = keys;
      return;
    }
    v.keys = null;
    const lines = v.mark ? text.split('\n') : [];
    if (v.mark > lines.length) v.mark = 0;
    if (!v.mark) { if (v.hl.firstChild) v.hl.textContent = ''; return; }
    const before = lines.slice(0, v.mark - 1).join('\n') + (v.mark > 1 ? '\n' : '');
    const after = (v.mark < lines.length ? '\n' : '') + lines.slice(v.mark).join('\n');
    v.hl.replaceChildren(document.createTextNode(before), h('mark', { text: lines[v.mark - 1] || ' ' }), document.createTextNode(after));
  }
  function highlightLine(cell, line) {
    const v = views.get(cell.id);
    if (!v || line < 1 || line > cell.source.split('\n').length) return;
    v.mark = line;
    paint(cell, true);
  }
  function clearHighlight(cell) {
    const v = views.get(cell.id);
    if (v && v.mark) { v.mark = 0; paint(cell); }
  }
  function selectLine(cell, line) {
    const v = views.get(cell.id);
    if (!v) return;
    const lines = cell.source.split('\n');
    if (line < 1 || line > lines.length) return;
    const start = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    if (cell.collapsed) toggleOutput(cell);
    highlightLine(cell, line);
    select(cell.id);
    v.src.focus();
    v.src.setSelectionRange(start, start + lines[line - 1].length);
    v.editor.scrollIntoView({ block: 'nearest' });
  }

  // ---- structure

  function insertCell(at, type, source, quiet) {
    const cell = newCell(type, source);
    at = Math.max(0, Math.min(nb.cells.length, at));
    nb.cells.splice(at, 0, cell);
    const li = makeView(cell);
    const next = nb.cells[at + 1];
    cellsEl.insertBefore(li, next ? views.get(next.id).li : null);
    autosize(views.get(cell.id));
    paint(cell, true);
    if (!quiet) { chromeAll(); scheduleSave(); }
    return cell;
  }

  function deleteCell(cell) {
    const i = indexOf(cell);
    if (i < 0) return;
    // a running cell is stopped, as by Stop: its stdin box goes with it
    if (kernel) { if (kernel.current === cell.id) kernel.stop(); else kernel.cancel(cell.id); }
    flushCell(cell);
    const snap = Object.assign({}, cell, { outputs: cell.outputs.map(stripOutput), sources: [], ops: [], rt: null,
                                           status: cell.status === 'running' || cell.status === 'waiting' || cell.status === 'queued' ? 'idle' : cell.status });
    trash.push({ cell: snap, index: i });
    if (trash.length > TRASH_MAX) trash.shift();
    const v = views.get(cell.id);
    const hadFocus = panel.contains(document.activeElement) && v.li.contains(document.activeElement);
    if (nearby) nearby.unobserve(v.li);
    v.li.remove();
    views.delete(cell.id);
    releaseMdIds(cell);
    nb.cells.splice(i, 1);
    if (!nb.cells.length) insertCell(0, 'code', '', true);
    const next = nb.cells[Math.min(i, nb.cells.length - 1)];
    chromeAll();
    select(next.id, { focus: hadFocus || selectedId === cell.id ? 'cell' : null });
    announce('Cell ' + (i + 1) + ' deleted');
    toast('Cell deleted.', 'Undo', undoDelete, 8000);
    scheduleSave();
    updateToolbar();
  }
  function undoDelete() {
    const t = trash.pop();
    if (!t) { announce('Nothing to undo'); return; }
    const cell = t.cell;
    if (byId(cell.id)) cell.id = L.newId();
    const at = Math.min(t.index, nb.cells.length);
    nb.cells.splice(at, 0, cell);
    const li = makeView(cell);
    const next = nb.cells[at + 1];
    cellsEl.insertBefore(li, next ? views.get(next.id).li : null);
    autosize(views.get(cell.id));
    paint(cell, true);
    updateBalance(cell);
    chromeAll();
    select(cell.id, { focus: 'cell' });
    hideToast();
    announce('Cell ' + (at + 1) + ' restored');
    scheduleSave();
  }

  function moveCell(cell, d, how) {
    const i = indexOf(cell), j = i + d;
    if (i < 0 || j < 0 || j >= nb.cells.length) return;
    const ae = document.activeElement;
    const sel = ae && ae.classList && ae.classList.contains('nb-src') ? [ae.selectionStart, ae.selectionEnd] : null;
    nb.cells.splice(i, 1);
    nb.cells.splice(j, 0, cell);
    const v = views.get(cell.id);
    const ref = nb.cells[j + 1];
    cellsEl.insertBefore(v.li, ref ? views.get(ref.id).li : null);
    chromeAll();
    if (sel) { ae.focus({ preventScroll: true }); ae.setSelectionRange(sel[0], sel[1]); }
    else if (how === 'button') {
      const b = d < 0 ? v.up : v.down;
      (b.disabled ? v.li : b).focus({ preventScroll: true });
    } else if (ae && v.li.contains(ae)) ae.focus({ preventScroll: true });
    v.li.scrollIntoView({ block: 'nearest' });
    announce('Cell moved to position ' + (j + 1));
    scheduleSave();
  }

  function setType(cell, type) {
    if (cell.type === type) return;
    if (kernel && cell.status === 'queued') kernel.cancel(cell.id);
    if (cell.status === 'running' || cell.status === 'waiting') return;
    const v = views.get(cell.id);
    const hadFocus = v && v.li.contains(document.activeElement);
    cell.type = type;
    releaseMdIds(cell);
    cell.outputs = [];
    cell.count = null;
    cell.status = 'idle';
    cell.stale = false;
    cell.ranSource = null;
    cell.editing = type === 'markdown' && !cell.source.trim();
    if (nearby) nearby.unobserve(v.li);
    const li = makeView(cell);
    v.li.replaceWith(li);
    autosize(views.get(cell.id));
    paint(cell, true);
    updateBalance(cell);
    chromeAll();
    select(cell.id, { focus: hadFocus ? 'cell' : null });
    announce('Cell ' + (indexOf(cell) + 1) + ' is now a ' + (type === 'code' ? 'code' : 'text') + ' cell');
    scheduleSave();
  }

  function toggleOutput(cell) {
    cell.collapsed = !cell.collapsed;
    chrome(cell);
    announce(cell.collapsed ? 'Output hidden' : 'Output shown');
  }

  // ---- selection and modes

  // the cell left with Esc: Tab right after it leaves the cell (Tab in
  // its editor indents)
  let tabOut = null;

  function select(id, opt) {
    opt = opt || {};
    const prev = selectedId && views.get(selectedId);
    if (prev && selectedId !== id) { prev.li.classList.remove('is-selected'); prev.li.tabIndex = -1; }
    selectedId = id;
    const v = views.get(id);
    if (!v) return;
    v.li.classList.add('is-selected');
    v.li.tabIndex = 0;
    if (opt.focus === 'cell') { v.li.focus({ preventScroll: true }); v.li.scrollIntoView({ block: 'nearest' }); }
    else if (opt.focus === 'editor') editCell(byId(id), opt.caret);
  }
  function editCell(cell, caret) {
    const v = views.get(cell.id);
    if (!v) return;
    if (cell.type === 'markdown' && !cell.editing) { cell.editing = true; chrome(cell); }
    select(cell.id);
    autosize(v);
    v.src.focus({ preventScroll: true });
    if (caret === 'start') v.src.setSelectionRange(0, 0);
    else if (caret === 'end') v.src.setSelectionRange(v.src.value.length, v.src.value.length);
    v.editor.scrollIntoView({ block: 'nearest' });
  }
  function commandMode(cell) {
    if (cell.type === 'markdown' && cell.editing) { cell.editing = false; renderMd(cell); chrome(cell); }
    select(cell.id, { focus: 'cell' });
  }
  function selectedCell() { return byId(selectedId) || nb.cells[0]; }

  cellsEl.addEventListener('focusin', e => {
    if (tabOut && e.target !== (views.get(tabOut) || {}).li) tabOut = null;
    const li = e.target.closest && e.target.closest('.nb-cell');
    if (li && li.dataset.id !== selectedId) select(li.dataset.id);
  });
  cellsEl.addEventListener('mousedown', e => {
    const li = e.target.closest('.nb-cell');
    if (!li) return;
    if (li.dataset.id !== selectedId) select(li.dataset.id);
    // a click on the cell's chrome (not a control) gives command mode
    if (!e.target.closest('textarea, input, button, a, summary, .nb-out, .nb-md, .nb-stdin')) {
      e.preventDefault();
      li.focus({ preventScroll: true });
    }
  });

  // ---- running

  // the source to run: with Settings › Straighten smart quotes, the curly
  // quotes of a phone keyboard made straight (in the editor too)
  function prepSource(cell) {
    if (P.settings.quotes) {
      const s = L.straightenQuotes(cell.source);
      if (s !== cell.source) {
        cell.source = s;
        const v = views.get(cell.id);
        if (v) { const a = v.src.selectionStart; v.src.value = s; v.src.setSelectionRange(a, a); paint(cell); }
      }
    }
    return cell.source;
  }
  // why nothing runs, with what to do about it (repl.js says it in two lines)
  const unavailableText = () => String(P.unavailableDetail || P.unavailable).replace(/\n/g, ' ');
  function unavailableNow() {
    if (P.unavailable) {
      setStatus('error', 'unavailable');
      showNotice('unavailable', unavailableText());
      return true;
    }
    if (!K) { setStatus('error', 'kernel unavailable'); return true; }
    return false;
  }
  function runCells(list) {
    for (const c of list) if (c.type === 'markdown' && c.editing) { c.editing = false; renderMd(c); chrome(c); }
    const code = list.filter(c => c.type === 'code');
    if (!code.length || unavailableNow()) return;
    const k = ensureKernel();
    if (!k) return;
    hideNotice('restored');
    const jobs = code.map(c => {
      const source = prepSource(c);
      c.sources.push(source);
      if (c.status !== 'queued' && c.status !== 'running' && c.status !== 'waiting') c.prevStatus = c.status;
      return { cellId: c.id, source };
    });
    if (jobs.length === 1) k.run(jobs[0].cellId, jobs[0].source);
    else k.runMany(jobs);
    updateToolbar();
  }
  function runOne(cell, then) {
    runCells([cell]);
    if (then === 'cell') select(cell.id, { focus: 'cell' });
  }
  function runAll() {
    runCells(nb.cells.slice());
  }
  async function restartKernel(andRun) {
    if (unavailableNow()) return;
    const k = ensureKernel();
    if (!k) return;
    hideNotice('settings');
    markStale(null);
    announce('Restarting the kernel');
    try { await k.restart(); } catch (e) { return; }
    announce('Kernel restarted');
    if (andRun) runAll();
  }
  function stop() {
    if (!kernel) return;
    kernel.stop();
    announce('Stopping');
  }
  // the kernel's state is lost (it restarts, or a new one starts next)
  function markStale(except) {
    session++;
    for (const c of nb.cells) {
      if (c === except || c.type !== 'code') continue;
      if (c.count != null || c.outputs.length) { c.stale = true; chrome(c); }
    }
  }

  function runKey(e, cell, fromEdit) {
    if (e.key !== 'Enter' || e.isComposing) return false;
    const mod = e.ctrlKey || e.metaKey;
    if (e.shiftKey && !mod && !e.altKey) {
      runCells([cell]);
      let i = indexOf(cell) + 1, created = false;
      if (i >= nb.cells.length) { insertCell(i, 'code', ''); created = true; }
      const next = nb.cells[i];
      if (next.type === 'code' && (fromEdit || created)) editCell(next, 'end');
      else select(next.id, { focus: 'cell' });
    } else if (mod && !e.shiftKey && !e.altKey) {
      runCells([cell]);
      if (cell.type === 'markdown' || !fromEdit) select(cell.id, { focus: 'cell' });
    } else if (e.altKey && !mod && !e.shiftKey) {
      runCells([cell]);
      const c = insertCell(indexOf(cell) + 1, 'code', '');
      editCell(c);
    } else return false;
    e.preventDefault();
    return true;
  }

  // the text editing helpers keep the browser's undo history when they can
  function insertText(ta, text) {
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }
  function deleteText(ta) {
    if (ta.selectionStart === ta.selectionEnd) return;
    let ok = false;
    try { ok = document.execCommand('delete', false); } catch (e) { ok = false; }
    if (!ok) {
      ta.setRangeText('', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }
  function reindent(ta, f) {
    const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    const s = v.lastIndexOf('\n', a - 1) + 1;
    let e = v.indexOf('\n', b > a && v[b - 1] === '\n' ? b - 1 : b);
    if (e < 0) e = v.length;
    const lines = v.slice(s, e).split('\n');
    const out = lines.map(f);
    const text = out.join('\n');
    if (text === v.slice(s, e)) return;
    ta.setSelectionRange(s, e);
    insertText(ta, text);
    if (lines.length === 1 && a === b) {
      const pos = Math.max(s, a + (out[0].length - lines[0].length));
      ta.setSelectionRange(pos, pos);
    } else ta.setSelectionRange(s, s + text.length);
  }

  function editKey(e, cell) {
    const ta = e.target;
    if (runKey(e, cell, true)) return;
    const mod = e.ctrlKey || e.metaKey;
    const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    if (e.key === 'Escape') { e.preventDefault(); commandMode(cell); tabOut = cell.id; return; }
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && !e.isComposing && cell.type === 'code') {
      // a line that closes a block goes back first ("end" + Enter), then
      // the new line is indented as this one, one level more if it
      // leaves a block or bracket open (or is an else or elseif)
      e.preventDefault();
      let ls = v.lastIndexOf('\n', a - 1) + 1;
      if (a === b && CLOSING.test(v.slice(ls, a))) dedentLine(ta, ls);
      const w = ta.value, c = ta.selectionStart;
      ls = w.lastIndexOf('\n', c - 1) + 1;
      const line = w.slice(ls, c);
      const indent = /^[ \t]*/.exec(line)[0];
      insertText(ta, '\n' + indent + (L.opensBlock(line) ? '  ' : ''));
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      if (!v) return;                   // an empty cell: Tab moves focus
      e.preventDefault();
      if (e.shiftKey) reindent(ta, l => l.replace(/^ {1,2}|^\t/, ''));
      else if (a !== b && v.slice(a, b).includes('\n')) reindent(ta, l => (l ? '  ' + l : l));
      else insertText(ta, '  ');
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && !mod && !e.shiftKey) {
      e.preventDefault();
      moveCell(cell, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp' && !e.altKey && !mod && !e.shiftKey && a === b && v.lastIndexOf('\n', a - 1) < 0) {
      const prev = nb.cells[indexOf(cell) - 1];
      if (prev) {
        e.preventDefault();
        if (cell.type === 'markdown' && cell.editing && cell.source.trim()) { cell.editing = false; renderMd(cell); chrome(cell); }
        if (prev.type === 'code' || prev.editing) editCell(prev, 'end'); else select(prev.id, { focus: 'cell' });
      }
      return;
    }
    if (e.key === 'ArrowDown' && !e.altKey && !mod && !e.shiftKey && a === b && v.indexOf('\n', a) < 0) {
      const next = nb.cells[indexOf(cell) + 1];
      if (next) {
        e.preventDefault();
        if (cell.type === 'markdown' && cell.editing && cell.source.trim()) { cell.editing = false; renderMd(cell); chrome(cell); }
        if (next.type === 'code' || next.editing) editCell(next, 'start'); else select(next.id, { focus: 'cell' });
      }
    }
  }

  let lastKey = '', lastKeyAt = 0;
  function commandKey(e, cell) {
    if (/^(Shift|Control|Alt|Meta)$/.test(e.key)) return;
    const out = tabOut === cell.id;
    tabOut = null;
    if (out && e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const next = nb.cells[indexOf(cell) + 1];
      if (next) select(next.id, { focus: 'cell' }); else $('nb-end-code').focus();
      return;
    }
    if (runKey(e, cell, false)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveCell(cell, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (mod || e.altKey) return;
    const k = e.key;
    const now = performance.now();
    const twice = k === lastKey && now - lastKeyAt < 800;
    lastKey = twice ? '' : k;
    lastKeyAt = now;
    const i = indexOf(cell);
    switch (k) {
    case 'ArrowUp': case 'k': if (i > 0) select(nb.cells[i - 1].id, { focus: 'cell' }); break;
    case 'ArrowDown': case 'j': if (i < nb.cells.length - 1) select(nb.cells[i + 1].id, { focus: 'cell' }); break;
    case 'Home': select(nb.cells[0].id, { focus: 'cell' }); break;
    case 'End': select(nb.cells[nb.cells.length - 1].id, { focus: 'cell' }); break;
    case 'Enter': editCell(cell, 'end'); break;
    case 'a': select(insertCell(i, 'code', '').id, { focus: 'cell' }); announce('Cell inserted above'); break;
    case 'b': select(insertCell(i + 1, 'code', '').id, { focus: 'cell' }); announce('Cell inserted below'); break;
    case 'd': if (twice) deleteCell(cell); break;
    case 'z': undoDelete(); break;
    case 'm': setType(cell, 'markdown'); break;
    case 'y': setType(cell, 'code'); break;
    case 'o': toggleOutput(cell); break;
    case 'i': if (twice) stop(); break;
    case '0':
      if (twice && (!kernelUsed || confirm('Restart the kernel? Its globals and state are lost.'))) restartKernel();
      break;
    case '?': openShortcuts(); break;
    default: return;
    }
    e.preventDefault();
  }

  cellsEl.addEventListener('keydown', e => {
    const li = e.target.closest('.nb-cell');
    if (!li) return;
    const cell = byId(li.dataset.id);
    if (!cell) return;
    if (e.target.classList.contains('nb-src')) editKey(e, cell);
    else if (e.target === li) commandKey(e, cell);
    else if (e.key === 'Escape' && !e.target.closest('.nb-stdin')) { e.preventDefault(); commandMode(cell); tabOut = cell.id; }
  });

  // anywhere on the tab: Ctrl+C stops when nothing is selected, Ctrl+S saves
  document.addEventListener('keydown', e => {
    if (panel.hidden || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && k === 'c') {
      if (!kernel || !kernel.current) return;
      // a selection to copy: in a text field, else in the document
      const sel = getSelection(), t = e.target;
      const field = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement;
      if (field ? t.selectionStart !== t.selectionEnd : sel && !sel.isCollapsed) return;
      e.preventDefault();
      stop();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === 's') {
      e.preventDefault();
      saveNow();
      toast(saveFailed ? 'Could not save in this browser.' : 'Saved in this browser.');
    }
  });

  // ---- toolbar, menu, notices

  function updateToolbar() {
    const busy = !!(kernel && (kernel.current || kernel.queueLength));
    $('nb-stop').setAttribute('aria-disabled', String(!busy));
  }
  $('nb-run').addEventListener('click', () => {
    const c = selectedCell();
    if (!c) return;
    runCells([c]);
    const next = nb.cells[indexOf(c) + 1];
    select((next || c).id, { focus: 'cell' });
  });
  $('nb-run-all').addEventListener('click', runAll);
  $('nb-stop').addEventListener('click', () => { if ($('nb-stop').getAttribute('aria-disabled') !== 'true') stop(); });
  $('nb-restart').addEventListener('click', () => restartKernel(false));
  $('nb-restart-run').addEventListener('click', () => restartKernel(true));
  $('nb-add-code').addEventListener('click', () => {
    const c = selectedCell();
    editCell(insertCell(c ? indexOf(c) + 1 : nb.cells.length, 'code', ''));
  });
  $('nb-upload-btn').addEventListener('click', () => menuAction('upload'));
  $('nb-keys-btn').addEventListener('click', openShortcuts);
  $('nb-settings').addEventListener('click', () => P.openSettings());
  $('nb-end-code').addEventListener('click', () => editCell(insertCell(nb.cells.length, 'code', '')));
  $('nb-end-text').addEventListener('click', () => editCell(insertCell(nb.cells.length, 'markdown', '')));

  const menu = $('nb-menu'), moreBtn = $('nb-more');
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
  function openMenu() {
    menu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    items()[0].focus();
  }
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    if (refocus) moreBtn.focus();
  }
  moreBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu(true)));
  moreBtn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); if (e.key === 'ArrowUp') items().at(-1).focus(); }
  });
  menu.addEventListener('keydown', e => {
    const list = items(), i = list.indexOf(document.activeElement);
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % list.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
    else if (e.key === 'Tab') { closeMenu(false); return; }
    if (j !== null) { e.preventDefault(); list[j].focus(); }
  });
  menu.addEventListener('click', e => {
    const b = e.target.closest('[role="menuitem"]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;   // disabled items stay focusable
    closeMenu(true);
    menuAction(b.dataset.act);
  });
  document.addEventListener('mousedown', e => {
    if (!menu.hidden && !menu.contains(e.target) && !moreBtn.contains(e.target)) closeMenu(false);
  });

  function menuAction(act) {
    switch (act) {
    case 'add-text': editCell(insertCell(indexOf(selectedCell()) + 1, 'markdown', '')); break;
    case 'restart-run': restartKernel(true); break;
    case 'clear-all':
      for (const c of nb.cells) {
        if (c.status === 'running' || c.status === 'waiting' || c.status === 'queued') continue;
        clearOutputs(c);
        c.count = null; c.status = 'idle'; c.stale = false; c.ranSource = null;
        clearHighlight(c);
        chrome(c);
      }
      announce('All outputs cleared');
      scheduleSave();
      break;
    case 'new':
      if (hasContent() && !confirm('Start a new, empty notebook? The current one is replaced; export it first to keep it.')) return;
      load({ title: 'Untitled', cells: [{ type: 'code', source: '' }] });
      editCell(nb.cells[0]);
      break;
    case 'example':
      if (hasContent() && !confirm('Replace the current notebook with the example? Export it first to keep it.')) return;
      load(example());
      break;
    case 'import': $('nb-file').click(); break;
    case 'export-lua': exportLua(); break;
    case 'export-json': exportJson(); break;
    case 'export-html': exportHtml(); break;
    case 'upload':
      if (P.unavailable && unavailableNow()) return;
      $('nb-upload').click();
      break;
    case 'settings': P.openSettings(); break;
    case 'keys': openShortcuts(); break;
    }
  }
  const hasContent = () => nb.cells.some(c => c.source.trim());
  function fileName(ext) {
    return (L.slug(nb.title || 'notebook').replace(/^section$/, 'notebook') || 'notebook') + ext;
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    announce('Exported ' + name);
  }

  // the focus in a notice or the toast that goes moves to the selected cell
  function focusSelected() {
    if (selectedId && views.has(selectedId)) select(selectedId, { focus: 'cell' });
  }

  let noticeKind = null;
  function showNotice(kind, text, action, alt) {
    noticeKind = kind;
    $('nb-notice-text').textContent = text;
    const set = (b, a) => {
      b.hidden = !a;
      if (a) {
        b.textContent = a[0];
        b.onclick = () => {
          const had = $('nb-notice').contains(document.activeElement);
          hideNotice();
          a[1]();
          if (had) focusSelected();       // (the action may have replaced the cells)
        };
      }
    };
    set($('nb-notice-action'), action);
    set($('nb-notice-alt'), alt);
    $('nb-notice').hidden = false;
    announce(text);
  }
  function hideNotice(kind) {
    if (kind && kind !== noticeKind) return;
    const had = $('nb-notice').contains(document.activeElement);
    $('nb-notice').hidden = true;
    noticeKind = null;
    if (had) focusSelected();
  }
  $('nb-notice-close').addEventListener('click', () => hideNotice());

  // the toast stays while it has the focus or the pointer
  const toastEl = $('nb-toast');
  let toastTimer = 0, toastMs = 3000;
  const toastHeld = () => toastEl.matches(':hover') || toastEl.contains(document.activeElement);
  function armToast() {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (!toastHeld()) hideToast(); }, toastMs);
  }
  for (const e of ['focusin', 'mouseenter']) toastEl.addEventListener(e, () => clearTimeout(toastTimer));
  for (const e of ['focusout', 'mouseleave'])
    toastEl.addEventListener(e, () => setTimeout(() => { if (!toastEl.hidden && !toastHeld()) armToast(); }, 0));
  function toast(text, actionLabel, action, ms) {
    const b = $('nb-toast-action');
    $('nb-toast-text').textContent = text;
    b.hidden = !action;
    if (action) { b.textContent = actionLabel; b.onclick = action; }
    toastEl.hidden = false;
    toastMs = ms || 3000;
    armToast();
  }
  function hideToast() {
    clearTimeout(toastTimer);
    const had = toastEl.contains(document.activeElement);
    toastEl.hidden = true;
    if (had) focusSelected();
  }

  let liveTimer = 0;
  function announce(text) {
    const live = $('nb-live');
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = text; }, 30);
  }

  let logLines = 0;
  function log(kind, text) {
    const pre = $('nb-log-text');
    const t = String(text).replace(/\n$/, '');
    if (!t) return;
    const line = (kind === 'stdout' || kind === 'stderr' ? '' : kind + ': ') + t + '\n';
    pre.appendChild(document.createTextNode(line));
    logLines += countLines(line);
    while (logLines > LOG_LINES && pre.firstChild) { logLines -= countLines(pre.firstChild.nodeValue); pre.firstChild.remove(); }
    $('nb-log').hidden = false;
    $('nb-log-summary').textContent = 'Kernel messages (' + logLines + ')';
    // a failed LUA_INIT, -l or -e: the kernel runs on, without it
    if ((kind === 'init' && !/ran$/.test(t)) || (kind === 'stderr' && /^lua: /.test(t))) $('nb-log').open = true;
  }

  // ---- shortcuts dialog

  const keysDlg = $('nb-shortcuts');
  let keysReturn = null;
  function openShortcuts() {
    if (keysDlg.open) return;
    keysReturn = document.activeElement;
    keysDlg.showModal();
  }
  keysDlg.addEventListener('close', () => { if (keysReturn && keysReturn.isConnected) keysReturn.focus(); });

  // ---- import, uploads

  $('nb-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > L.LIMITS.file) { showNotice('import', 'Could not import ' + f.name + ': the file is larger than 5 MB.'); return; }
    let res;
    try {
      const text = await f.text();
      res = /\.json$/i.test(f.name) || /^\s*\{/.test(text) ? L.fromJson(text) : L.splitPercent(text);
      if (res.cells.length > L.LIMITS.cells) throw new Error('more than ' + L.LIMITS.cells + ' cells');
    } catch (err) {
      showNotice('import', 'Could not import ' + f.name + ': ' + ((err && err.message) || err));
      return;
    }
    if (!res.cells.length) { showNotice('import', 'Could not import ' + f.name + ': it has no cells.'); return; }
    if (hasContent() && !confirm('Replace the current notebook with ' + f.name + '? Export it first to keep it.')) return;
    load({ title: res.title || f.name.replace(/\.[^.]*$/, ''), created: res.created, cells: res.cells }, true);
    if (res.warnings && res.warnings.length) showNotice('import', res.warnings.join(' '));
    announce('Imported ' + f.name + ': ' + res.cells.length + ' cells');
  });

  // how Lua code loads an uploaded file
  const useHint = name => (/\.lua$/i.test(name) ? 'dofile("' + name + '") or require "' + name.replace(/\.lua$/i, '') + '"'
    : /\.(png|jpe?g|gif|webp)$/i.test(name) ? 'notebook.image("' + name + '")' : 'io.open("' + name + '")');
  async function upload(files) {
    if (!files.length || (P.unavailable && unavailableNow())) return;
    await P.uploadFiles(files);
    const names = files.map(f => f.name.replace(/^.*[\\/]/, ''));
    toast('Uploaded ' + clip(names.join(', '), 60) + '. Use it with ' + useHint(names[0]) + '.', null, null, 6000);
  }
  $('nb-upload').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    upload(files);
  });
  P.onUpload((name, data) => { if (kernel) kernel.writeFile(P.HOME + name, data); });
  panel.addEventListener('dragover', e => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); panel.classList.add('drop'); }
  });
  panel.addEventListener('dragleave', e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop'); });
  panel.addEventListener('drop', e => {
    panel.classList.remove('drop');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    upload([...e.dataTransfer.files]);
  });

  // the Settings never restart the notebook's kernel (its state is the
  // user's work): a notice offers it
  addEventListener('lua:settings', () => {
    if (kernel && kernelState !== 'off' && kernelState !== 'unavailable')
      showNotice('settings', 'Settings changed — restart the kernel to apply them.', ['Restart kernel', () => restartKernel(false)]);
  });

  // ---- tab activation

  let visited = false;
  function activate() {
    toolbar.hidden = false;
    resizeAll();
    if (!visited) {
      visited = true;
      if (!P.unavailable && K) startKernel();
    }
  }
  addEventListener('lua:tab', e => {
    if (!e.detail || e.detail.tab !== 'notebook') { closeMenu(false); return; }
    activate();
  });

  // ---- persistence

  function stripOutput(o) {             // without the DOM text node
    const r = {};
    for (const k in o) if (k[0] !== '_') r[k] = o[k];
    return r;
  }
  function capOutputs(outs, max) {
    if (max === Infinity) return outs.filter(o => !o.transient).map(stripOutput);
    let left = max;
    const r = [];
    for (const o of outs) {
      if (o.transient) continue;
      const size = o.k === 'error' ? JSON.stringify(o.error).length : String(o.text != null ? o.text : o.data != null ? o.data : '').length;
      if (size <= left) { r.push(stripOutput(o)); left -= size; continue; }
      if ((o.k === 'stream' || o.k === 'value') && left > 200 && o.text != null) {
        r.push(Object.assign(stripOutput(o), { text: o.text.slice(0, left) }));
      }
      r.push({ k: 'note', text: '… more output was not saved' });
      break;
    }
    return r;
  }
  function snapshot(withOutputs, max) {
    return {
      title: nb.title, created: nb.created, modified: nb.modified, lua: P.VERSION || null, arch: P.ARCH || null,
      cells: nb.cells.map(c => {
        if (c.type !== 'code') return { id: c.id, type: c.type, source: c.source, count: null, status: null, outputs: [] };
        const outputs = withOutputs ? capOutputs(c.outputs, max || SAVE_OUT_MAX) : [];
        // a cell still running has partial outputs: it is saved as interrupted
        if (c.status === 'running' || c.status === 'waiting') {
          if (withOutputs) outputs.push({ k: 'note', text: 'Unfinished when the notebook was saved.' });
          return { id: c.id, type: c.type, source: c.source, count: c.runCount != null ? c.runCount : c.count,
                   status: 'interrupted', outputs };
        }
        return { id: c.id, type: c.type, source: c.source, count: c.count,
                 status: c.status === 'queued' ? c.prevStatus : c.status, outputs };
      }),
    };
  }

  // Export .json: every output, unless the file would be larger than
  // Import accepts (L.LIMITS.file, in UTF-8 bytes as File.size counts
  // them); then the outputs are capped per cell, as little as needed.
  const EXPORT_CAPS = [Infinity, 1024 * 1024, 256 * 1024, SAVE_OUT_MAX, 16 * 1024, 4096, 0];
  // Nor more outputs per cell than Import keeps (L.LIMITS.outputs): the
  // first ones, a note and the last one, as Import would.
  const utf8Bytes = s => new TextEncoder().encode(s).length;
  // after an export: a notice if Import would refuse the file (TOOBIG,
  // the notice for a file over 5 MB, or more than 5000 CELLS); true then
  function exportRefused(tooBig, cells) {
    if (tooBig) showNotice('export', tooBig);
    else if (cells > L.LIMITS.cells)
      showNotice('export', 'This notebook has more than ' + L.LIMITS.cells + ' cells: Import cannot read the file back.');
    else return false;
    return true;
  }
  function exportLua() {
    const s = L.toPercent(snapshot(false));
    download(fileName('.lua'), s, 'text/plain');
    const big = utf8Bytes(s) > L.LIMITS.file;   // else: the cells Import finds in it
    exportRefused(big && 'This notebook is larger than 5 MB: Import cannot read the file back.',
                  big ? 0 : L.splitPercent(s).cells.length);
  }
  function exportJson() {
    let s, cap, fits = false, cut = false;
    for (cap of EXPORT_CAPS) {
      const snap = cap ? snapshot(true, cap) : snapshot(false);
      cut = false;
      for (const c of snap.cells) {
        const outs = L.limitOutputs(c.outputs, L.LIMITS.outputs);
        if (outs !== c.outputs) { c.outputs = outs; cut = true; }
      }
      s = L.toJson(snap);
      if ((fits = utf8Bytes(s) <= L.LIMITS.file)) break;
    }
    download(fileName('.json'), s, 'application/json');
    if (exportRefused(!fits && 'This notebook is larger than 5 MB even without its outputs: Import cannot read the file back.',
                      nb.cells.length)) return;
    if (cap !== Infinity)
      toast('Some outputs were left out, to keep the file within the 5 MB that Import reads.', null, null, 6000);
    else if (cut)
      toast('Some outputs were left out: Import reads at most ' + L.LIMITS.outputs + ' per cell.', null, null, 6000);
  }

  // Export .html: the notebook as the page shows it, as a static page of
  // its own (no script, nothing loaded from elsewhere).  Its DOM is made
  // of trees the page already trusts: markdown rendered again (all code
  // blocks colored), the sources highlighted (up to SYN_MAX characters
  // each, as in the editor, and HTML_SYN_MAX in all) and copies of the
  // output areas without their buttons; it is serialized, never assembled
  // from strings, and read back before it is saved (see settle).  Its
  // style is the page's own rules for these parts, taken from the text of
  // index.html's <style id="page-style"> and of notebook.css (<link
  // id="nb-style">, fetched once: the CSSOM is the fallback, as Chrome
  // serializes a shorthand with var() and a longhand after it as empty
  // longhands), with the code as the editor shows it (CSS_CODE) and a few
  // rules for the layout of a static page.
  const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  const HTML_SYN_MAX = 1024 * 1024;
  // the page's rules kept: tokens, the cells, their counts and status
  // bars, markdown, outputs and colors; not those of the editor, the
  // controls or the selection
  const CSS_KEEP = /^(?::root(?::not\(\[data-theme=.light.\]\))?|code|kbd|details > summary)$|\.(?:nb-(?:cell|gutter|body|md|out|rich|stream|value|note|error|trace|count)|md-|syn-)/;
  const CSS_DROP = /nb-(?:editor|src|hl|bal|run|tools|stdin|more|hidden-out)|is-selected|is-editing|:hover|button|\.empty|#/;
  // the exported code (.nb-code) has the frame of the editor and the text
  // of its textarea: these properties of their rules
  const CSS_CODE = { '.nb-editor': /^(?:border|border-[\w-]+|background)$/,
                     '.nb-src': /^(?:margin|padding|font|font-[\w-]+|line-height|color|white-space|overflow-wrap|tab-size|letter-spacing)$/ };
  const EXPORT_CSS = `
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); -webkit-text-size-adjust: 100%; }
.nbx { max-width: 1120px; margin: 0 auto; padding: 0 max(16px, env(safe-area-inset-right)) 16px max(16px, env(safe-area-inset-left)); }
.nbx-head { margin: 0 0 10px 60px; padding: 14px 0 8px; border-bottom: 1px solid var(--border); }
.nbx-title { margin: 0; color: var(--muted); font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.nb-cells { display: flex; flex-direction: column; gap: 4px; }
.nb-gutter { padding-top: 11px; }
.nb-code code { font: inherit; white-space: inherit; }
.nb-out { content-visibility: visible; }
.nbx-hidden > summary { margin: 4px 0 0 12px; color: var(--muted); font: 12.5px/1.6 var(--sans); }
.nbx-foot { margin: 20px 0 0 60px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12.5px; }
@media (max-width: 640px) {
  .nbx-head, .nbx-foot { margin-left: 0; }
  .nb-gutter { padding: 0 0 2px; }
}
@media print {
  body { background: none; }
  .nbx { max-width: none; padding: 0; }
  .nb-md pre, .nb-rich pre, .nb-value { overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
  .nb-md pre code, .nb-rich pre code { white-space: pre-wrap; }
}`;
  // notebook.css's text, for the export (fetched when the tab loads)
  let nbCssText = null;
  (function fetchCss() {
    const link = $('nb-style');
    if (!link || typeof fetch !== 'function') return;
    fetch(link.href).then(r => (r.ok ? r.text() : null)).then(t => { if (t) nbCssText = t; }).catch(() => {});
  })();
  function nbCss() {
    if (nbCssText) return nbCssText;
    const link = $('nb-style');
    try { return [...link.sheet.cssRules].map(r => r.cssText).join('\n'); } catch (e) { return ''; }
  }
  // [prelude, body] of each top-level block of CSS text (the source, not
  // the CSSOM: see above)
  function cssBlocks(t) {
    const out = [];
    let q = null, depth = 0, start = 0, open = 0;
    for (let j = 0; j < t.length; j++) {
      const c = t[j];
      if (q) { if (c === '\\') j++; else if (c === q) q = null; }
      else if (c === '"' || c === '\'') q = c;
      else if (c === '{') { if (!depth++) open = j; }
      else if (c === '}') { if (depth && !--depth) { out.push([t.slice(start, open).trim(), t.slice(open + 1, j)]); start = j + 1; } }
      else if (c === ';' && !depth) start = j + 1;
    }
    return out;
  }
  // the selectors of a list (not split at the commas of :is(a, b) or [x="a,b"])
  function selectors(t) {
    const out = [];
    let depth = 0, start = 0;
    for (let j = 0; j < t.length; j++) {
      const c = t[j];
      if (c === '(' || c === '[') depth++;
      else if ((c === ')' || c === ']') && depth) depth--;
      else if (c === ',' && !depth) { out.push(t.slice(start, j)); start = j + 1; }
    }
    out.push(t.slice(start));
    return out.map(s => s.trim().replace(/\s+/g, ' '));
  }
  function exportCss() {
    const style = $('page-style'), light = [];
    const keep = text => {
      const out = [];
      for (const [head, body] of cssBlocks(text)) {
        const decls = body.trim().replace(/\s+/g, ' ');
        if (/^@(?:media|supports|container|layer)\b/.test(head)) {
          const inner = keep(body);
          if (inner.length) out.push(head.replace(/\s+/g, ' ') + ' {\n  ' + inner.join('\n  ') + '\n}');
        } else if (head[0] !== '@') {
          const all = selectors(head), sel = all.filter(s => CSS_KEEP.test(s) && !CSS_DROP.test(s));
          if (sel.length) out.push(sel.join(', ') + ' { ' + decls + ' }');
          for (const s of all) {
            const code = CSS_CODE[s] && decls.split(';').map(d => d.trim()).filter(d => CSS_CODE[s].test(d.slice(0, d.indexOf(':')).trim()));
            if (code && code.length) out.push('.nb-code { ' + code.join('; ') + '; }');
          }
          if (head === ':root') light.push(decls);
        }
      }
      return out;
    };
    const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [...(style ? keep(strip(style.textContent)) : []), ...keep(strip(nbCss()))];
    // printed light, whatever the scheme: no dark page on paper
    if (light.length) out.push('@media print {\n  :root:not([data-theme="light"]) { ' + light.join(' ') + ' }\n}');
    return out.join('\n') + EXPORT_CSS + '\n';
  }
  // a copy of what an output area shows, without its controls
  function staticOutputs(cell, v) {
    const out = v.out.cloneNode(true);
    out.hidden = false;
    for (const e of out.querySelectorAll('[hidden]')) e.remove();
    for (const b of out.querySelectorAll('button.where')) b.replaceWith(h('span', { class: 'where', text: b.textContent }));
    for (const b of out.querySelectorAll('button')) b.remove();
    for (const e of out.querySelectorAll('.nb-value.clamped')) e.classList.remove('clamped');
    if (!out.firstChild) return null;
    return cell.collapsed ? h('details', { class: 'nbx-hidden' }, h('summary', { text: 'Output hidden' }), out) : out;
  }
  // the text of the page; the parser drops a newline right after <pre>,
  // so one more goes before a newline that starts one
  function pageText(doc) {
    const added = [];
    for (const p of doc.querySelectorAll('pre')) {
      const t = p.firstChild;
      if (t && t.nodeType === 3 && t.data[0] === '\n') { t.insertData(0, '\n'); added.push(t); }
    }
    const s = '<!doctype html>\n' + doc.documentElement.outerHTML + '\n';
    for (const t of added) t.deleteData(0, 1);
    return s;
  }
  // the text of DOC, made to read back as DOC.  The parser reads a CR as
  // a newline (the page shows it as a space) and drops a NUL, so they go
  // first.  And a tree built with the DOM may parse into another: an <li>
  // in a <div> in an <li>, with no list between, closes the outer <li>,
  // and its </div> then a <div> of the page.  Until the text reads back
  // the same, the first cell that does not loses its outputs (.nb-rich)
  // that do not read back alone, or else all it shows.
  function settle(doc, list) {
    doc.normalize();
    const w = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
    for (let t; (t = w.nextNode());)
      if (/[\r\0]/.test(t.data)) t.data = t.data.replace(/\r\n/g, '\n').replace(/\r/g, ' ').replace(/\0/g, '');
    doc.normalize();
    const DP = new DOMParser(), read = s => DP.parseFromString(s, 'text/html');
    const same = (a, b) => a.head.isEqualNode(b.head) && b.body.childElementCount === 1 && a.body.firstElementChild.isEqualNode(b.body.firstElementChild);
    const alone = e => {
      const d = document.implementation.createHTMLDocument();
      d.body.appendChild(d.importNode(e, true));
      return same(d, read(pageText(d)));
    };
    const note = () => h('p', { class: 'nb-note bad', text: 'output left out: its markup does not read back the same in a static page' });
    for (let tries = 2 * list.children.length + 2; tries-- > 0;) {
      const text = pageText(doc), back = read(text);
      if (same(doc, back)) return text;
      const ours = list.children, got = (back.querySelector('.nb-cells') || back.body).children;
      let j = 0;
      while (j < ours.length && got[j] && ours[j].isEqualNode(got[j])) j++;
      if (j === ours.length) break;
      const bad = [...ours[j].querySelectorAll('.nb-rich')].filter(e => !alone(e));
      if (bad.length) for (const e of bad) e.replaceWith(note());
      else ours[j].querySelector('.nb-body').replaceChildren(note());
    }
    return pageText(doc);
  }
  function exportHtml() {
    const doc = document.implementation.createHTMLDocument('');
    const ids = new Set(), list = h('div', { class: 'nb-cells' });
    let heading = '', syn = HTML_SYN_MAX;
    // colored while the budget lasts (a big notebook is not frozen)
    const colors = s => s.length <= syn && ((syn -= s.length), true);
    for (const cell of nb.cells) {
      const v = views.get(cell.id);
      if (!v) continue;
      // cells are not <li>: the markup of an output cannot close one
      const div = h('div', { class: 'nb-cell', 'data-type': cell.type });
      if (cell.type === 'markdown') {
        if (!cell.source.trim()) continue;
        const md = h('div', { class: 'nb-md' }, L.renderMarkdown(cell.source, document, 'nb-h-', ids, !colors(cell.source)));
        const hd = !heading && md.querySelector('h1, h2, h3, h4, h5, h6');
        if (hd) heading = hd.textContent.trim();
        div.append(h('div', { class: 'nb-body' }, md));
      } else {
        const out = staticOutputs(cell, v);
        if (!cell.source.trim() && !out) continue;
        for (const k of ['status', 'stale', 'edited']) if (v.li.dataset[k]) div.dataset[k] = v.li.dataset[k];
        const code = h('code', null, cell.source.length <= SYN_MAX && colors(cell.source) ? L.highlightDom(cell.source, document) : cell.source);
        div.append(h('div', { class: 'nb-gutter' }, h('span', { class: 'nb-count', text: v.count.textContent })),
                   h('div', { class: 'nb-body' }, h('pre', { class: 'nb-code' }, code), out));
      }
      list.appendChild(div);
    }
    const title = heading || (nb.title.trim() && nb.title.trim() !== 'Untitled' ? nb.title.trim() : '') || 'Lua notebook';
    const now = new Date();
    doc.documentElement.lang = 'en';
    doc.head.replaceChildren(h('meta', { charset: 'utf-8' }), h('meta', { 'http-equiv': 'Content-Security-Policy', content: HTML_CSP }),
                             h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
                             h('meta', { name: 'color-scheme', content: 'light dark' }),
                             h('title', { text: title }), h('style', { text: exportCss() }));
    doc.body.appendChild(h('div', { class: 'nbx' },
      h('header', { class: 'nbx-head' }, h('p', { class: 'nbx-title', text: title })),
      h('main', null, list),
      h('footer', { class: 'nbx-foot' }, 'Exported from the Lua ' + P.VERSION + ' notebook on ',
        h('time', { datetime: now.toISOString(), text: now.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }) }))));
    download(fileName('.html'), settle(doc, list), 'text/html');
  }

  let saveTimer = 0, saveFailed = false, lastSaved = null, saveHeld = false;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }
  // A saved notebook this page cannot read (one saved by a later version
  // of the page, or damaged) would be lost to the next autosave: it is
  // copied to UNREADABLE_KEY first, which nothing else writes, and the
  // notice offers it as a file.  When that copy cannot be made (storage
  // full, or an earlier unreadable save is kept there), autosave is held
  // until the user chooses to replace the save.
  const UNREADABLE_KEY = 'notebook.unreadable';
  function keepUnreadable(text) {
    const prev = P.store.get(UNREADABLE_KEY, null);
    const kept = prev === text || (prev == null && P.store.set(UNREADABLE_KEY, text));
    const get = () => download('unreadable-notebook.json', text, 'application/json');
    if (kept)
      showNotice('restored', 'The saved notebook could not be read, so the example was loaded. ' +
                 'A copy of the save is kept in this browser.', ['Download it', get]);
    else {
      saveHeld = true;
      const show = () => showNotice('restored', 'The saved notebook could not be read, so the example was loaded. ' +
                                    'Changes are not saved until you replace it: download it first to keep it.',
                                    ['Download it', () => { get(); show(); }],
                                    ['Replace it', () => { saveHeld = false; saveNow(); }]);
      show();
    }
  }
  function write(s) {
    if (!P.store.set(SAVE_KEY, s)) return false;
    lastSaved = s;
    return true;
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (saveHeld) return;
    nb.modified = new Date().toISOString();
    if (!nb.created) nb.created = nb.modified;
    const s = L.toJson(snapshot(true));
    let ok = s.length <= SAVE_MAX && write(s);
    if (!ok) ok = write(L.toJson(snapshot(false)));
    if (!ok && !saveFailed) {
      showNotice('save', 'Autosave failed: browser storage is full or blocked. Export the notebook to keep your work.',
                 ['Export .json', () => menuAction('export-json')]);
    } else if (ok && saveFailed) hideNotice('save');
    saveFailed = !ok;
  }
  addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) saveNow(); });
  // two saved notebooks that differ at most in when they were saved
  function sameSave(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
      const x = JSON.parse(a), y = JSON.parse(b);
      if (x.meta) x.meta.modified = null;
      if (y.meta) y.meta.modified = null;
      return JSON.stringify(x) === JSON.stringify(y);
    } catch (e) { return false; }
  }
  addEventListener('storage', e => {
    if (e.key !== STORE_PREFIX + SAVE_KEY || !e.newValue || sameSave(e.newValue, lastSaved)) return;
    // Load theirs loads what the other tab saved then, not what storage
    // holds when it is clicked: this tab's autosave may have replaced it
    // since (and the other tab may be gone), so it is saved again.
    const theirs = e.newValue;
    showNotice('storage', 'This notebook was changed in another tab.',
               ['Load theirs', () => { if (restore(theirs, false)) write(theirs); }],
               ['Keep mine', () => saveNow()]);
  });

  // {title, created, cells: [{id?, type, source, count?, status?, outputs?}]}
  function load(doc, stale) {
    if (kernel) {                       // the cells go, and their stdin boxes
      if (kernel.current && byId(kernel.current)) kernel.stop();
      for (const c of nb.cells) if (c.status === 'queued') kernel.cancel(c.id);
    }
    trash.length = 0;                   // deleted cells belong to the notebook replaced
    hideToast();
    mdIds.clear();
    mdIdsOf.clear();
    for (const v of views.values()) v.li.remove();
    views.clear();
    if (nearby) nearby.disconnect();
    dirty.clear();
    nb.title = doc.title || 'Untitled';
    nb.created = doc.created || null;
    nb.cells = [];
    const seen = new Set();
    for (const d of doc.cells) {
      // as the editor has it: a lone \r would be a line break there, not in the overlay
      const c = newCell(d.type === 'markdown' ? 'markdown' : 'code', String(d.source || '').replace(/\r\n?/g, '\n'));
      if (d.id && !seen.has(d.id)) c.id = d.id;
      seen.add(c.id);
      c.editing = c.type === 'markdown' && !c.source.trim();
      if (c.type === 'code') {
        c.count = Number.isInteger(d.count) ? d.count : null;
        c.outputs = (d.outputs || []).map(o => Object.assign({}, o));
        c.ranSource = c.count != null ? c.source : null;
        c.status = d.status === 'error' || d.status === 'interrupted' ? d.status
          : c.outputs.some(o => o.k === 'error' || (o.k === 'note' && o.bad)) ? 'error' : c.count != null ? 'ok' : 'idle';
        c.stale = !!stale && (c.count != null || c.outputs.length > 0);
      }
      nb.cells.push(c);
    }
    if (!nb.cells.length) nb.cells.push(newCell('code', ''));
    const frag = document.createDocumentFragment();
    for (const c of nb.cells) frag.appendChild(makeView(c));
    cellsEl.appendChild(frag);
    for (const c of nb.cells) updateBalance(c);
    chromeAll();
    $('nb-title').value = nb.title;
    selectedId = null;
    select(nb.cells[0].id);
    resizeAll();
    scheduleSave();
  }

  // the page's own save, which Import's size limits do not apply to
  function restore(text, first) {
    let res;
    try { res = L.fromJson(text, { limits: false }); } catch (e) { return false; }
    if (!res.cells.length) return false;
    load({ title: res.title, created: res.created, cells: res.cells }, true);
    // it is what is saved: writing it again would tell the other tabs it changed
    clearTimeout(saveTimer);
    saveTimer = 0;
    lastSaved = text;
    nb.modified = res.modified;
    if (res.warnings.length) showNotice('restored', 'Restored from your last visit. ' + res.warnings.join(' '));
    else if (nb.cells.some(c => c.stale))
      showNotice('restored', 'Restored from your last visit. Outputs are from an earlier session.', ['Run all', runAll]);
    else if (!first) hideNotice('storage');
    return true;
  }

  // ---- the example notebook

  function example() {
    const md = s => ({ type: 'markdown', source: s });
    const code = s => ({ type: 'code', source: s });
    return { title: 'A tour of the notebook', cells: [
      md('# Lua notebook\n\n' +
         'Write Lua in the code cells and run them with **Shift+Enter** (run and move on) or **Ctrl+Enter** ' +
         '(run in place); **Run all** runs the whole notebook from the top. A cell that ends in an expression ' +
         'shows its value, and the `notebook` module shows tables, HTML, SVG, Markdown and images.\n\n' +
         '- The notebook has its own interpreter: what you define here is not visible in the **Console** tab, and the other way round.\n' +
         '- Press **Esc** for command mode, then **?** for every shortcut.\n' +
         '- The notebook is saved in this browser as you type. **File** exports it as `.lua`, as `.json` (with outputs) or as a `.html` page to read or print.'),
      code('function fact(n) if n <= 1 then return 1 end return n * fact(n - 1) end\n' +
           '-- a cell shows what it returns, or the value of an expression on its last lines\n' +
           'fact(20)'),
      code('for i = 1, 5 do print(i, i * i) end'),
      code('notebook.table({{1, "one"}, {2, "two"}}, {"n", "name"})'),
      code('-- an SVG bar chart built from an element tree; it follows the page theme\n' +
           'local values = {1, 4, 9, 16, 25, 36, 49, 64}\n' +
           'local h, top = 120, math.max(table.unpack(values))\n' +
           'local chart = {"svg", viewBox = ("0 0 %d %d"):format(36 * #values, h + 20),\n' +
           '               width = 36 * #values, height = h + 20}\n' +
           'for i, v in ipairs(values) do\n' +
           '  local x, bh = 36 * (i - 1), v * h // top\n' +
           '  chart[#chart + 1] = {"g",\n' +
           '    {"rect", x = x, y = h - bh, width = 28, height = bh, rx = 3, style = "fill: var(--accent)"},\n' +
           '    {"text", x = x + 14, y = h + 15, ["font-size"] = 11, ["text-anchor"] = "middle",\n' +
           '     fill = "currentColor", v}}\n' +
           'end\n' +
           'chart'),
      code('-- notebook.show with an id updates an output in place\n' +
           'for i = 0, 10 do\n' +
           '  notebook.show(notebook.html{"progress", max = 10, value = i}, "p")\n' +
           '  notebook.sleep(0.2)\n' +
           'end\n' +
           '"done"'),
      code('-- the last line is the value, though the local is gone after the cell\n' +
           'local t = {}\n' +
           '#t'),
      code('-- errors stop "Run all"; open the traceback for details\n' +
           'nil + 1'),
      code('-- a cell can read input\n' +
           'io.write("Your name? ") print("Hello, " .. io.read() .. "!")'),
      md('## Tips\n\n' +
         '- A cell is one chunk: its `local`s end with it, so keep what later cells need in globals.\n' +
         '- **Upload** (or dropping files here) copies files into the home directory: then `dofile("file.lua")`, ' +
         '`require "file"` or `notebook.image("plot.png")`.\n' +
         '- `notebook.html`, `notebook.svg` and `notebook.markup` take element trees, `{"tag", attr = value, child, …}`; ' +
         'markup is cleaned of scripts and external resources before it is shown.\n' +
         '- **File → Export .lua** gives a plain Lua file (cells as `-- %%` sections); bare final expressions and ' +
         '`notebook.*` calls only work here.\n' +
         '- **File → Export .html** gives a page of the notebook as you see it, outputs included, that opens without this site.'),
    ] };
  }

  // ---- start

  $('nb-title').addEventListener('input', () => { nb.title = $('nb-title').value; scheduleSave(); });
  $('nb-title').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); const c = selectedCell(); if (c) select(c.id, { focus: 'cell' }); }
  });
  $('nb-info').textContent = infoLine(null, null);

  const saved = P.store.get(SAVE_KEY, null);
  if (!(saved && restore(saved, true))) {
    load(example());
    if (saved) keepUnreadable(saved);
    clearTimeout(saveTimer);          // nothing to save until the first change
    saveTimer = 0;
  }

  if (P.unavailable) {
    for (const id of ['nb-run', 'nb-run-all', 'nb-restart', 'nb-restart-run', 'nb-upload-btn']) $(id).disabled = true;
    menu.querySelector('[data-act="restart-run"]').setAttribute('aria-disabled', 'true');
    $('nb-stop').setAttribute('aria-disabled', 'true');
    menu.querySelector('[data-act="upload"]').setAttribute('aria-disabled', 'true');
    setStatus('error', 'unavailable');
    showNotice('unavailable', unavailableText());
  } else if (!K) {
    fail('The notebook kernel (nb-kernel.js) did not load. Reload the page.');
  }
  // the tab shown already (repl.js's lua:tab follows, which changes nothing then)
  if (!panel.hidden) activate();
})();

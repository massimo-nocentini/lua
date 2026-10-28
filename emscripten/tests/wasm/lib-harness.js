// lib-harness.js - unit tests of notebook-lib.js in node (no wasm, no DOM)
//
// Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
// Copyright Notice in lua.h).
//
// usage: node lib-harness.js
//
// notebook-lib.js is a UMD module, so node can require it: the Lua
// highlighter, the balance badge and auto-indent scanner, splitChunks
// (import of a file without markers), straightenQuotes (the "Straighten
// smart quotes" setting, LuaPage.straightenQuotes) and the .lua and .json
// file formats are plain functions of strings.  This checks them without
// a browser, as cases L1-L8 of the design's test plan.  The markdown
// renderer and the sanitizer need a DOM: page.spec.mjs tests those.
// Exits with status 1 if any case fails.

'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', '..', 'web', 'notebook-lib.js'));

let failures = 0, passes = 0;
const J = x => JSON.stringify(x);
function assert(c, msg) { if (!c) throw new Error('assertion failed: ' + msg); }
function eq(a, b, what) { assert(J(a) === J(b), what + ': expected ' + J(b) + ', got ' + J(a)); }
function check(name, f) {
  try { f(); passes++; console.log('ok - ' + name); }
  catch (e) { failures++; console.log('not ok - ' + name + '\n  ' + String((e && e.message) || e).slice(0, 2000)); }
}

// a reproducible pseudo-random generator (xorshift32)
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
const kinds = src => L.highlight(src).filter(([k]) => k && k !== 'text' && k !== 'plain' && k !== 'space');
const kindOf = (src, word) => L.highlight(src).filter(([, t]) => t === word).map(([k]) => k);

check('L1 highlighter round trip', () => {
  const corpus = [
    '', 'local x <const> = 1', 'local f <close> = nil', 'goto done ::done::', 'a.b:c()', 'x = 0x1p4 + 1e-3 + 0xA.8p-1 + 3.',
    'if a then b() elseif c then d() else e() end', 'while x do x = x - 1 end', 'repeat x = x + 1 until x > 9',
    'for i = 1, 10, 2 do end', 'for k, v in pairs(t) do end', 'function t.a.b:c(...) return ... end',
    'local function f() end', 'return not a and b or c', 'x = #t // 2 ~ 3 << 1 >> 1 & 4 | 5',
    '"unterminated', "'unterminated\nnext", '"esc \\" \\n \\z\n  x"', '"\\\n"',
    '[[long]]', '[=[lvl 1 ]] ]=]', '[==[lvl 2 ]=] ]==]', '[===[lvl 3]===]', '[==[ unterminated',
    '--[[ long comment ]] x', '--[==[ unterminated long comment', '-- line comment\nx', '--[ not long\ny',
    'global x', 'global function g() end', 'global <const> *', 'global = 1', 't.global', 'local global = 1',
    'return global * 2', 'do global x end', 'x = 1; global y', ':: l :: global z',
    '\u00e9\u0000\u00ff\ud83d\ude00 \t\r\n', '...', 'nil true false', '<=>=~===', '::label::',
  ];
  const r = rng(42);
  const atoms = ['local ', 'x', ' = ', '"s"', "'q'", '[[', ']]', '[=[', ']=]', '--', '--[[', '\n', '\\', '0x1p4',
                 '1e-3', '(', ')', '{', '}', '::', 'global', ' ', 'end', 'function', '.', ':', '<const>', '\u00e9', '\0'];
  let mix = '';
  while (mix.length < 1 << 20) mix += r() < 0.1 ? String.fromCharCode(Math.floor(r() * 0x2fff)) : atoms[Math.floor(r() * atoms.length)];
  corpus.push(mix);
  for (const src of corpus) {
    const pieces = L.highlight(src);
    assert(Array.isArray(pieces) && pieces.every(p => Array.isArray(p) && typeof p[1] === 'string'), 'pieces for ' + J(src.slice(0, 40)));
    const back = pieces.map(p => p[1]).join('');
    assert(back === src, 'round trip of ' + J(src.slice(0, 60)) + (src.length > 60 ? '…' : ''));
  }
});

check('L2 highlighter kinds', () => {
  const ks = kinds('local s = [[a]] -- c').map(([k, t]) => k + ':' + t);
  for (const want of ['special:local', 'string:[[a]]', 'comment:-- c'])
    assert(ks.includes(want), want + ' in ' + J(ks));
  eq(kindOf('global x', 'global'), ['special'], 'global x');
  eq(kindOf('global function f() end', 'global'), ['special'], 'global function');
  eq(kindOf('global <const> *', 'global'), ['special'], 'global <const> *');
  // a statement starts after a local's attribute too
  eq(kindOf('local x <close> global y', 'global'), ['special'], 'global after <close>');
  eq(kindOf('local x <const> global y', 'global'), ['special'], 'global after <const>');
  for (const src of ['global = 1', 't.global', 'local global', 'return global * 2'])
    assert(!kindOf(src, 'global').includes('special'), src + ': ' + J(L.highlight(src)));
  eq(kindOf('print(1)', 'print'), ['keyword'], 'print');
  assert(!kindOf('t.print(1)', 'print').includes('keyword'), 't.print: ' + J(L.highlight('t.print(1)')));
  assert(!kindOf('t:print(1)', 'print').includes('keyword'), 't:print');
  eq(kindOf('x = nil', 'nil'), ['constant'], 'nil');
  eq(kindOf('f(...)', '...'), ['constant'], '...');
  const q = kinds('local x <const> = 1 ::l::').map(([k, t]) => k + ':' + t);
  assert(q.includes('quote:<const>') && q.includes('quote:::l::'), 'quote kinds: ' + J(q));
  const n = kinds('x = 0x1p4 + 1e-3').filter(([k]) => k === 'number').map(([, t]) => t);
  eq(n, ['0x1p4', '1e-3'], 'numbers');
  assert(kinds('f()').some(([k, t]) => k === 'paren' && t.includes('(')), 'paren');
});

check('L3 linear time on pathological inputs', () => {
  const shapes = { '[=': '[=', '"\\': '"\\', '--[': '--[', '(': '(' };
  const fns = { highlight: L.highlight, balance: L.balance, straightenQuotes: L.straightenQuotes, splitChunks: L.splitChunks };
  const time = (f, s) => {
    let best = Infinity;
    for (let k = 0; k < 3; k++) { const t = process.hrtime.bigint(); f(s); best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6); }
    return best;
  };
  const slow = [];
  for (const [fname, f] of Object.entries(fns)) {
    for (const [sname, unit] of Object.entries(shapes)) {
      for (const n of [1e5]) {
        const small = unit.repeat(n / unit.length), big = unit.repeat(10 * n / unit.length);
        const a = Math.max(time(f, small), 2), b = time(f, big);
        if (b > 25 * a) slow.push(`${fname} on ${J(sname)}: ${a.toFixed(1)} ms -> ${b.toFixed(1)} ms`);
      }
    }
  }
  assert(!slow.length, 'quadratic: ' + slow.join('; '));
});

check('L4 balance', () => {
  const text = s => L.balance(s).text;
  eq(text('function f()'), "unclosed 'function'", 'function f()');
  eq(text('end'), '1 extra end', 'end');
  eq(text('f('), 'unclosed (', 'f(');
  eq(text('x = "a'), 'unfinished string', 'x = "a');
  for (const s of ['if a then else end', 'repeat until x', 'global function g() end', 'local global = 1',
                   'local s = "end" -- end', 'x = [[ function ]]', 'for i = 1, 2 do end', 'while x do end'])
    assert(L.balance(s).ok && text(s) === '', s + ': ' + J(L.balance(s)));
});

check('L5 splitChunks', () => {
  eq(L.splitChunks('a = 1\n\nb = 2'), ['a = 1', 'b = 2'], 'two chunks');
  eq(L.splitChunks('function f()\n\nend'), ['function f()\n\nend'], 'a blank line inside a function');
  eq(L.splitChunks('x = [[\n\n]]'), ['x = [[\n\n]]'], 'a blank line inside a long string');
});

check('L6 straightenQuotes', () => {
  const S = L.straightenQuotes;
  eq(S('print(\u201chi\u201d)'), 'print("hi")', 'double curly');
  eq(S('x = \u2018a\u2019'), "x = 'a'", 'single curly');
  eq(S("print('it\u2019s')"), "print('it\u2019s')", 'an apostrophe in a straight string');
  eq(S('print("\u201cq\u201d")'), 'print("\u201cq\u201d")', 'curly quotes in a straight string');
  eq(S('-- \u201cc\u201d'), '-- \u201cc\u201d', 'a comment');
  eq(S('[[\u201cx\u201d]]'), '[[\u201cx\u201d]]', 'a long string');
  eq(S('print(\u201ca\\\u201db\u201d)'), 'print("a\\\u201db")', 'an escaped quote is content');
  eq(S('\u2018it\u2019s\u2019'), "'it's'", 'the documented ambiguity');
});

check('L7 .lua export and import round trip', () => {
  const nb = { title: 't', cells: [
    { type: 'code', source: 'x = 1\n-- %%\n-- %% [markdown]\n--\\ %%\ny = 2' },
    { type: 'markdown', source: '# Title\n\ntext\n\n-- not a marker' },
    { type: 'code', source: 'print(x)' },
  ] };
  const text = L.toPercent(nb);
  assert(/^-- %%$/m.test(text) && /^-- %% \[markdown\]$/m.test(text), 'markers: ' + text);
  const back = L.splitPercent(text);
  eq(back.cells.map(c => [c.type, c.source]), nb.cells.map(c => [c.type, c.source]), 'cells');
  eq(back.title, 't', 'title');
});

check('L8 .json import validation', () => {
  const throws = (f, re, what) => {
    let msg = null;
    try { f(); } catch (e) { msg = e.message; }
    assert(msg !== null, what + ': not rejected');
    assert(re.test(msg), what + ': message ' + J(msg));
  };
  const nb = (o = {}) => JSON.stringify(Object.assign({ format: 'lua-notebook', version: 1, meta: {}, cells: [] }, o));
  eq(L.fromJson(nb({ cells: [{ id: 'a', type: 'code', source: '1' }] })).cells.map(c => c.source), ['1'], 'a valid file');
  throws(() => L.fromJson(nb({ format: 'chicken-notebook' })), /format "lua-notebook" expected/, 'a wrong format');
  throws(() => L.fromJson(nb({ version: 2 })), /version/, 'version 2');
  throws(() => L.fromJson(nb({ version: 0 })), /version/, 'version 0');
  throws(() => L.fromJson(nb({ cells: [{ type: 'code', source: 'x'.repeat(5 * 1024 * 1024 + 1) }] })), /larger than 5 MB/, 'a file over 5 MB');
  const n = L.LIMITS.cells + 1;
  throws(() => L.fromJson(nb({ cells: Array.from({ length: n }, () => ({ type: 'code', source: '' })) })),
         new RegExp('more than ' + L.LIMITS.cells + ' cells'), 'too many cells');
  throws(() => L.fromJson('{'), /not valid JSON/, 'not JSON');
  const j = JSON.parse(L.toJson({ title: 'x', cells: [{ id: 'c1', type: 'code', source: '1' }] }));
  eq([j.format, j.version], ['lua-notebook', 1], 'toJson');
});

console.log('# ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);

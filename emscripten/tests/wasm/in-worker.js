// in-worker.js - run a node build of the Lua wasm port inside a worker thread
//
// Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
// Copyright Notice in lua.h).
//
// usage: node in-worker.js STACK_MB TOOL.js [ARG ...]
//
// Browser workers get a much smaller native stack than node's main thread
// (about 1 MB).  This runs TOOL.js (e.g. emscripten/build/wasm64/node/lua.js,
// the node build of the unmodified lua.c) in a worker_threads Worker
// limited to STACK_MB megabytes of stack, with ARG ... as its command
// line, and exits with the tool's exit status.  run-testes.sh uses it to
// show that Lua's 200 C levels (LUAI_MAXCCALLS) end in Lua's own "C stack
// overflow" before such a stack overflows (cstack.lua, errors.lua).
//
// The tool's stdin, stdout and stderr are the process's own (the node
// build uses NODERAWFS, which reads and writes the real descriptors), and
// a node flag given to this script (--liftoff ...) applies to the worker.

'use strict';
const { Worker } = require('worker_threads');
const path = require('path');

const [stackMb, tool, ...args] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node in-worker.js STACK_MB TOOL.js [ARG ...]');
  process.exit(2);
}

const code = `
  const { workerData } = require('worker_threads');
  process.argv = [process.execPath, workerData.tool, ...workerData.args];
  require(workerData.tool);
`;
const w = new Worker(code, {
  eval: true,
  workerData: { tool: path.resolve(tool), args },
  resourceLimits: { stackSizeMb: Number(stackMb) || 1 },
});
w.on('error', e => { console.error('in-worker: ' + ((e && e.stack) || e)); process.exitCode = 1; });
w.on('exit', status => { if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = status; });

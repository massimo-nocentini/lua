// wasm-arch.js - tell a wasm32 module from a wasm64 (memory64) one
//
// Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
// Copyright Notice in lua.h).
//
// usage: node wasm-arch.js FILE.wasm ...
//
// Prints, for each module, "wasm64" if its linear memory is 64-bit
// (memory64, as emscripten's MEMORY64 makes it) and "wasm32" otherwise,
// read from the module's memory section: the limits flags have bit 2 set
// for a 64-bit memory.  Exits with status 1 if a module has no memory
// section of its own (emscripten modules define and export theirs).
//
// Required as a module it exports arch(FILE) instead: the harnesses use
// it to check that the module they load for --arch=A is an A build (R38).

'use strict';
const fs = require('fs');

function leb(b, pos) {
  let v = 0, shift = 0, byte;
  do { byte = b[pos.i++]; v += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return v;
}

function arch(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x0061736d) throw new Error(file + ': not a wasm module');
  const pos = { i: 8 };
  while (pos.i < b.length) {
    const id = b[pos.i++], size = leb(b, pos), end = pos.i + size;
    if (id === 5) {                     // memory section
      if (leb(b, pos) < 1) break;
      return b[pos.i] & 0x04 ? 'wasm64' : 'wasm32';
    }
    pos.i = end;
  }
  throw new Error(file + ': no memory section');
}

if (require.main === module) {
  let status = 0;
  for (const f of process.argv.slice(2)) {
    try { console.log(arch(f)); }
    catch (e) { console.error('wasm-arch: ' + e.message); status = 1; }
  }
  process.exit(status);
} else {
  module.exports = { arch };
}

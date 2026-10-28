#!/bin/sh
# run-testes.sh - Lua's own test suite (testes/) under the WebAssembly node build
#
# Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
# Copyright Notice in lua.h).
#
# usage (every path absolute; "make -C emscripten testes" sets them):
#   NODE=... WASM_ARCH=A LUA=.../build/A/node/lua LUA_JS=.../build/A/node/lua.js \
#   IN_WORKER=.../tests/wasm/in-worker.js TESTES=.../testes OUT=.../build/A/testes \
#   PRELUDE=.../tests/testes-prelude.lua sh run-testes.sh
#
# The suite runs in a copy (OUT), as it writes files next to itself.
#
# 1. all.lua with _U=true (the "user" mode of the suite: no tests that
#    need the C test library, ltests.c, which is not linked), stdin a
#    pipe (files.lua expects it to be unseekable).  It must print
#    "final OK" and exit 0.
#
# 2. The worker lane: cstack.lua and errors.lua in a worker_threads
#    Worker with a 1 MB engine stack, under unoptimised code (--liftoff
#    --no-wasm-tier-up, whose frames are larger), as a browser worker
#    would run them.  They nest pcall, metamethods, gsub callbacks and
#    the parser up to Lua's 200 C levels (LUAI_MAXCCALLS) and expect
#    Lua's own "C stack overflow": each must exit 0 and print its final
#    "OK" line (cstack.lua writes a finalizer's "." after it, natively
#    too), and nothing may show an engine error (RangeError: the
#    engine stack; RuntimeError, Aborted: the linear stack).  See
#    WASM_MAXCCALLS and WASM_STACK_SIZE in emscripten/Makefile for the
#    remedies, should this ever fail.

set -eu

for v in LUA LUA_JS IN_WORKER TESTES OUT PRELUDE; do
  eval "p=\${$v:?$v must be set}"
  case $p in
    /*) ;;
    *) echo "run-testes.sh: $v must be an absolute path, not $p" >&2; exit 1 ;;
  esac
done
NODE=${NODE:-node}
WASM_ARCH=${WASM_ARCH:-?}
export NODE

rm -rf "$OUT"
cp -R "$TESTES" "$OUT"
cp "$PRELUDE" "$OUT/testes-prelude.lua"
cd "$OUT"
engine='RangeError|RuntimeError|Aborted'

echo "# $WASM_ARCH: testes/all.lua (node $("$NODE" --version))"
st=0
: | "$LUA" -e '_U=true' -e 'dofile("testes-prelude.lua")' all.lua >all.log 2>&1 || st=$?
if test "$st" != 0 || ! grep -q 'final OK' all.log || grep -Eq "$engine" all.log; then
  echo "not ok - all.lua (status $st), the end of $OUT/all.log:"
  tail -30 all.log | sed 's/^/# /'
  exit 1
fi
echo "ok - all.lua: $(grep 'final OK' all.log | head -1)"

for f in cstack.lua errors.lua; do
  st=0
  : | "$NODE" --liftoff --no-wasm-tier-up "$IN_WORKER" 1 "$LUA_JS" \
    -e 'dofile("testes-prelude.lua")' "$f" >"$f.log" 2>&1 || st=$?
  if test "$st" != 0 || ! grep -q '^OK$' "$f.log" || grep -Eq "$engine" "$f.log"; then
    echo "not ok - $f in a 1 MB worker (status $st), the end of $OUT/$f.log:"
    tail -30 "$f.log" | sed 's/^/# /'
    exit 1
  fi
  echo "ok - $f in a 1 MB worker, liftoff"
done
echo "# $WASM_ARCH: the test suite passed"

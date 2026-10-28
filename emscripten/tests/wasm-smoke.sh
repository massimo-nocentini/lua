#!/bin/sh
# wasm-smoke.sh - smoke tests for the WebAssembly (node) build of Lua
#
# Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
# Copyright Notice in lua.h).
#
# usage: NODE=... WASM_ARCH=wasm64|wasm32 LUA=/abs/build/A/node/lua sh wasm-smoke.sh
#
# "make -C emscripten smoke" runs it once per architecture.  LUA is the
# node wrapper of the unmodified lua.c (build/A/node/lua), which runs
# like the native lua: the host's stdin, files, environment and exit
# status (NODERAWFS).  It must be an absolute path, as the script changes
# directory.  WASM_ARCH says which build it is: size_t (string.packsize
# "T") must agree with it, while lua_Integer is 64-bit on both.
#
# Each check prints "ok - N name"; the first failure prints "not ok",
# what was expected and the output, and exits with status 1.  An engine
# error in any output (RangeError, RuntimeError, Aborted) is a failure,
# whatever the check compares.  Nothing is written outside a mktemp -d
# directory, which is removed at the end.

set -eu

: "${LUA:?LUA must name the node wrapper (build/A/node/lua)}"
: "${WASM_ARCH:?WASM_ARCH must be wasm64 or wasm32}"
NODE=${NODE:-node}
export NODE

case $LUA in
  /*) ;;
  *) echo "wasm-smoke.sh: LUA must be an absolute path, not $LUA" >&2; exit 1 ;;
esac
case $WASM_ARCH in
  wasm64) sizet=8 ;;
  wasm32) sizet=4 ;;
  *) echo "wasm-smoke.sh: WASM_ARCH must be wasm64 or wasm32, not $WASM_ARCH" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
n=0

# fail NAME EXPECTED: report the last run and stop
fail() {
  echo "not ok - $n $1"
  echo "# expected: $2"
  echo "# status: $st"
  sed 's/^/# out: /' "$tmp/out"
  sed 's/^/# err: /' "$tmp/err"
  exit 1
}

# run CMD ...: run it with output in $tmp/out and $tmp/err, status in $st
# (under -e a failing command must not end the script: st=0; cmd || st=$?)
run() {
  st=0
  "$@" >"$tmp/out" 2>"$tmp/err" || st=$?
  if grep -Eq 'RangeError|RuntimeError|Aborted' "$tmp/out" "$tmp/err"; then
    fail "$name" "no engine error"
  fi
}

# check NAME EXPECTED-STDOUT CMD ...: stdout exactly, and status 0
check() {
  name=$1 want=$2
  shift 2
  n=$((n + 1))
  run "$@"
  if test "$st" != 0 || test "$(cat "$tmp/out")" != "$want"; then fail "$name" "$want"; fi
  echo "ok - $n $name"
}

echo "# $WASM_ARCH: $LUA (node $("$NODE" --version))"

check "version banner" 'Lua 5.5.1  Copyright (C) 1994-2026 Lua.org, PUC-Rio' "$LUA" -v

check "expression" 3 "$LUA" -e 'io.write(1+2)'

check "size_t is $sizet bytes, lua_Integer 64-bit" "$sizet 9223372036854775807" \
  "$LUA" -e 'io.write(string.packsize("T"), " ", math.maxinteger)'

check "pcall of error" 'false table 2' \
  "$LUA" -e 'local ok, e = pcall(error, {}) io.write(tostring(ok), " ", type(e), " ", select("#", pcall(error)))'

check "coroutine generator" '1 2 3' "$LUA" -e '
  local gen = coroutine.wrap(function () for i = 1, 3 do coroutine.yield(i) end end)
  io.write(gen(), " ", gen(), " ", gen(), "\n")'

name="script on stdin"
n=$((n + 1))
st=0
printf 'print(6*7)\n' | "$LUA" - >"$tmp/out" 2>"$tmp/err" || st=$?
if test "$st" != 0 || test "$(cat "$tmp/out")" != 42; then fail "$name" 42; fi
echo "ok - $n $name"

name="os.exit status"
n=$((n + 1))
run "$LUA" -e 'os.exit(3)'
if test "$st" != 3; then fail "$name" "status 3"; fi
echo "ok - $n $name"

# files and require, relative to the working directory
mkdir "$tmp/d"
printf 'return {v = 7}\n' >"$tmp/d/m.lua"
check "file write, read back and require" 'hello 7' sh -c 'cd "$1" && LUA_PATH="./?.lua" "$2" -e "
  local f = assert(io.open(\"f.txt\", \"w\")) f:write(\"hello\") f:close()
  f = assert(io.open(\"f.txt\")) local s = f:read(\"a\") f:close()
  io.write(s, \" \", require(\"m\").v)"' sh "$tmp/d" "$LUA"
if ! test -f "$tmp/d/f.txt"; then fail "file on the host" "$tmp/d/f.txt"; fi

name="deep recursion: stack overflow"
n=$((n + 1))
run "$LUA" -e 'local function f() return 1 + f() end; print(pcall(f))'
if test "$st" != 0 || ! grep -q '^false.*stack overflow' "$tmp/out"; then
  fail "$name" "false ... stack overflow"
fi
echo "ok - $n $name"

check "1 MiB string" 1048576 "$LUA" -e 'print(#string.rep("x", 2^20))'

echo "# $WASM_ARCH: all $n checks passed"

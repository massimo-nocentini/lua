# syntax=docker/dockerfile:1
#
# Lua built from a checkout of this tree with its developer makefile,
# installed in /usr/local.
# Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
#
# The build context is the root of the checkout; this file need not be
# inside it:
#
#     docker build -f .github/docker/Dockerfile -t lua .
#
# Everything is compiled and linked with clang.  The makefile links
# with $(CC) too, so CC=clang on the make command line is enough.
# CWARNGCC holds the warnings that only gcc knows (-Wlogical-op,
# -Wno-aggressive-loop-optimizations); clang would report both as
# unknown options on every file it compiles, so it is emptied, which
# leaves a warning-free build.  Nothing upstream is edited: the
# makefile is driven only from the command line.
#
# The makefile has no install target, so the build stage installs by
# hand what an installed Lua has: lua, liblua.a and the four public
# headers.  This tree has no luac.c, hence no luac, and no lua.pc.
# ltests.c is in the makefile's object list, but without LUA_DEBUG
# (the makefile's TESTS, left empty) it compiles to an empty object,
# so liblua.a is the plain library.
#
# The upstream test suite (testes/) runs in the build stage, before
# anything is installed, and a failure fails the build.  It runs as
# upstream's own "all" script runs it, with two concessions to the
# environment:
#
#   - lua.c dlopens "libreadline.so" for line editing (LUA_USE_LINUX
#     sets LUA_READLINELIB to that name), and only libreadline-dev
#     ships the unversioned name.  main.lua needs it: it runs "lua -E
#     -i" and requires that no "unable to load readline" warning
#     appears.  The final image keeps it for the interactive lua.
#
#   - files.lua expects io.stdin not to be seekable; the stdin of RUN
#     is /dev/null, which is, so the suite reads from a pipe.
#
# "ulimit -S -s 1100" is the first line of the "all" script, which is
# how the Lua authors run the suite: it bounds the C stack to about
# 1.1 MB, so that cstack.lua's deep recursions show that the 200
# LUAI_MAXCCALLS levels fit a small stack.  It is a soft limit, set in
# the subshell that runs the suite only.  The arm64 leg of the image
# workflow is its check (arm64 frames are larger): the build fails if
# the suite fails there.  If it ever fails on arm64 with a segmentation
# fault, the remedy is to drop the ulimit line for every platform (the
# default 8 MiB stack only adds margin).
#
# The final stage smoke tests the installed Lua the three ways it is
# used: the interpreter, a C module loaded by require (lua is linked
# with -Wl,-E, so the module finds the API in the executable), and a
# program embedding liblua.a.  It then proves that lua was compiled by
# clang from the .comment section (readelf is in binutils, which clang
# depends on for ld).  The crt objects from libc6-dev add a "GCC:"
# entry of their own, so the check looks for clang's entry rather than
# for the absence of gcc's.

# ubuntu:24.04 is multi-platform: each build pulls its own platform's
# image.  It is pinned, not :latest: on 26.04 (glibc 2.43) files.lua
# fails under Docker's default seccomp profile, which answers clone3
# with ENOSYS.  glibc's system() then falls back to clone and succeeds,
# but leaves errno at ENOSYS, and luaL_execresult, seeing a nonzero
# status with a nonzero errno, makes os.execute("exit 3") return
# nil, "Function not implemented", 38 where io.popen gives the exit.
ARG BASE=ubuntu:24.04

FROM ${BASE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libc6-dev libreadline-dev make \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN set -eu; \
    make -j"$(nproc)" CC=clang CWARNGCC=; \
    make -C testes/libs CC=clang; \
    (cd testes && ulimit -S -s 1100 && : | ../lua -W all.lua); \
    install -d /out/usr/local/bin /out/usr/local/include /out/usr/local/lib \
               /out/usr/local/share/lua/5.5 /out/usr/local/lib/lua/5.5; \
    install -m 755 lua /out/usr/local/bin/; \
    install -m 644 lua.h luaconf.h lualib.h lauxlib.h /out/usr/local/include/; \
    install -m 644 liblua.a /out/usr/local/lib/

FROM ${BASE}
# C modules and programs embedding Lua are built with the clang Lua was
# built with; libreadline-dev gives the "libreadline.so" the
# interpreter dlopens for line editing
ENV CC=clang
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libc6-dev libreadline-dev make \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/usr/local/ /usr/local/
RUN lua -v \
 && test "$(lua -e 'io.write(1 + 2)')" = 3 \
 && printf '%s\n' '#include "lua.h"' '#include "lauxlib.h"' \
      'static int add (lua_State *L) {' \
      '  lua_pushinteger(L, luaL_checkinteger(L, 1) + luaL_checkinteger(L, 2));' \
      '  return 1;' \
      '}' \
      'int luaopen_t (lua_State *L) { lua_pushcfunction(L, add); return 1; }' >/tmp/t.c \
 && clang -O2 -fPIC -shared /tmp/t.c -o /usr/local/lib/lua/5.5/t.so \
 && test "$(lua -e 'io.write(require "t"(1, 2))')" = 3 \
 && printf '%s\n' '#include "lua.h"' '#include "lauxlib.h"' '#include "lualib.h"' \
      'int main (void) {' \
      '  lua_State *L = luaL_newstate();' \
      '  int st;' \
      '  if (L == NULL) return 1;' \
      '  luaL_openlibs(L);' \
      '  st = luaL_dostring(L, "io.write(6*7)");' \
      '  lua_close(L);' \
      '  return st != LUA_OK;' \
      '}' >/tmp/e.c \
 && clang -O2 /tmp/e.c -llua -lm -ldl -o /tmp/e \
 && test "$(/tmp/e)" = 42 \
 && readelf -p .comment /usr/local/bin/lua | grep -q 'clang version' \
 && rm -f /tmp/t.c /usr/local/lib/lua/5.5/t.so /tmp/e.c /tmp/e
CMD ["lua"]

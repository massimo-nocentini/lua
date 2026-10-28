# emscripten/Makefile - WebAssembly builds of Lua with Emscripten -*- Makefile -*-
#
# Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
# Copyright Notice in lua.h).
#
# Usage, with emsdk_env.sh sourced (GNU make):
#
#   make -C emscripten [target] [KNOB=value ...]
#
# Upstream Lua is compiled unmodified, from the sources one directory up,
# with -DLUA_USE_POSIX only: everything web-specific happens at run time
# in webrepl-main.c.  Every output goes to emscripten/build/ (ignored by
# emscripten/.gitignore): one directory per architecture, each with its
# objects, liblua.a, the node CLI and the web module, and build/web/, the
# web page with every architecture's module.  Nothing here reads the
# output of the upstream makefile.
#
#   build/A/liblua.a          every l*.c but lua.c and ltests.c
#   build/A/node/lua          the unmodified lua.c, run by node (NODERAWFS:
#                             the host's files, stdin, environment and exit
#                             status), as the native "lua" would run
#   build/A/web/lua-repl.js   the web module (webrepl-main.c, MODULARIZE,
#                             factory createLuaRepl), notebook.lua embedded
#   build/web/                the page (web/), the first of WASM_WEB_ARCHS
#                             beside index.html, every other one in its
#                             own subdirectory
#
# Targets: all (= web), web, node, lib, smoke, testes, harness, check
# (smoke testes harness), page-test (Playwright, not part of check),
# serve, clean.
#
# The architectures: wasm64 (-m64, emscripten's MEMORY64; setjmp/longjmp
# lowered to the standard wasm exception handling, exnref) is the page's
# own; wasm32 (-m32, legacy exception handling) is the build for engines
# without memory64 (Safari, every iOS browser) and about 1.5x faster.
# Lua's lua_Integer is 64-bit on both.

EMDIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
SRCDIR := $(patsubst %/,%,$(dir $(EMDIR)))
B := $(EMDIR)/build

EMCC ?= emcc
EMAR ?= emar
# make's own lookup of a plain "node" would stop at the emsdk root, a
# directory on the PATH after emsdk_env.sh, hence the shell's.
ifeq ($(origin NODE),undefined)
NODE := $(or $(EMSDK_NODE),$(firstword $(shell command -v node)),node)
endif
PYTHON ?= python3

# knobs

# the page's architectures: the first sits beside index.html, each other
# in build/web/<arch>/
WASM_WEB_ARCHS ?= wasm64 wasm32
# the architectures of the node CLI, smoke and testes
WASM_ARCHS ?= $(WASM_WEB_ARCHS)
# setjmp/longjmp (Lua's errors): "wasm" lowers them to wasm exception
# handling with the standard exnref instructions, "wasm-legacy" with the
# legacy ones (Firefox reports them deprecated, but older engines and
# JavaScriptCore have only those), "emscripten" to JS exceptions
WASM_SJLJ_wasm64 ?= wasm
WASM_SJLJ_wasm32 ?= wasm-legacy
# the heap may grow to 16 GB on wasm64 (V8's limit); on wasm32 to 2 GB,
# not 4, so that pointers stay below 2^31 (JS glue may see them signed)
WASM_MAXIMUM_MEMORY_wasm64 ?= 17179869184
WASM_MAXIMUM_MEMORY_wasm32 ?= 2147483648
WASM_INITIAL_MEMORY ?= 16777216
# The linear-memory C stack.  Lua's C recursion is bounded by
# LUAI_MAXCCALLS (200 levels); tests/run-testes.sh shows that they end in
# Lua's own "C stack overflow" with this stack and a browser worker's
# engine stack.  If a stack lane ever fails with a RangeError (the engine
# stack), set WASM_MAXCCALLS to the largest value that passes, for that
# architecture, and say why here; if it fails with a linear-stack
# corruption (seen as "Aborted" under WASM_DEBUG=1), raise WASM_STACK_SIZE.
WASM_STACK_SIZE ?= 1048576
# empty: upstream's 200 (a define, -DLUAI_MAXCCALLS=n, not a source change)
WASM_MAXCCALLS ?=
# a JavaScriptCore shell (jsc): enables the jsc lane of 'harness' (local only)
JSC ?=
# notebook.lua is embedded in the web module at /lua-web/notebook.lua
NOTEBOOK_LUA ?= $(EMDIR)/notebook.lua
ifdef WASM_DEBUG
WASM_OPT ?= -g -O0
WASM_LINK_OPT ?= -g -O0 -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2
else
WASM_OPT ?= -O2
WASM_LINK_OPT ?= -O2
endif

ifneq ($(filter-out wasm64 wasm32,$(WASM_WEB_ARCHS) $(WASM_ARCHS)),)
$(error WASM_WEB_ARCHS and WASM_ARCHS may list wasm64 and wasm32 only)
endif
ifeq ($(strip $(WASM_WEB_ARCHS)),)
$(error WASM_WEB_ARCHS must list at least one architecture)
endif

ALL_ARCHS := $(sort $(WASM_ARCHS) $(WASM_WEB_ARCHS))
PRIMARY := $(firstword $(WASM_WEB_ARCHS))
OTHERS := $(wordlist 2,$(words $(WASM_WEB_ARCHS)),$(WASM_WEB_ARCHS))

LUA_LIB_C := $(filter-out ltests.c lua.c,$(notdir $(wildcard $(SRCDIR)/l*.c)))
LUA_LIB_O := $(LUA_LIB_C:.c=.o)

ARCHFLAG_wasm64 = -m64
ARCHFLAG_wasm32 = -m32

SJLJFLAGS_wasm = -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=0
SJLJFLAGS_wasm-legacy = -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1
SJLJFLAGS_emscripten = -sSUPPORT_LONGJMP=emscripten
EH_wasm = exnref
EH_wasm-legacy = legacy
EH_emscripten = none

# the web module's interface (webrepl.h).  On wasm64 JS sees pointers as
# BigInt; SIGNATURE_CONVERSIONS lets it pass these as Numbers, as _malloc
# and stringToNewUTF8 return them (no effect on wasm32).
WEB_EXPORTS = _main,_webrepl_feed,_webrepl_post,_webrepl_resume,_webrepl_interrupt,_webrepl_state,_webrepl_prompt,_webrepl_started,_webrepl_exited,_webrepl_exit_code,_webrepl_wakeup_ms,_webrepl_set_slice_ms,_webrepl_stdin_read,_webrepl_note_output,_webrepl_flush_stdout,_malloc,_free
WEB_SIGS = webrepl_feed:_p__,webrepl_post:_p_,webrepl_stdin_read:_p_
WEB_RUNTIME = FS,ENV,stringToNewUTF8,lengthBytesUTF8,HEAPU8

NODE_LDFLAGS = -sENVIRONMENT=node -sNODERAWFS=1 -sNODE_HOST_ENV=1 -sEXIT_RUNTIME=1
WEB_LDFLAGS = -sENVIRONMENT=web,worker,node -sMODULARIZE=1 -sEXPORT_NAME=createLuaRepl \
  -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 -sEXPORTED_FUNCTIONS=$(WEB_EXPORTS) \
  -sSIGNATURE_CONVERSIONS=$(WEB_SIGS) -sEXPORTED_RUNTIME_METHODS=$(WEB_RUNTIME)

# Per architecture A.  config.mk records every flag and knob that
# affects A; it is rewritten only when that changes (cmp), and every
# object depends on it, so changing a knob rebuilds just what it must.
# -Wl,--stack-first puts the C stack below static data: a large overflow
# then traps instead of corrupting data.  ABORTING_MALLOC=0: Lua handles
# a failed allocation ("not enough memory").
define ARCH_VARS
EMFLAGS_$1 = $$(ARCHFLAG_$1) $$(SJLJFLAGS_$$(WASM_SJLJ_$1))
CFLAGS_$1 = -std=c99 -Wall -Wextra $$(WASM_OPT) -DLUA_USE_POSIX \
  $$(if $$(WASM_MAXCCALLS),-DLUAI_MAXCCALLS=$$(WASM_MAXCCALLS)) $$(EMFLAGS_$1) -I$$(SRCDIR) -I$$(EMDIR)
COMMON_LDFLAGS_$1 = $$(EMFLAGS_$1) $$(WASM_LINK_OPT) -Wl,--stack-first -sSTACK_SIZE=$$(WASM_STACK_SIZE) \
  -sINITIAL_MEMORY=$$(WASM_INITIAL_MEMORY) -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=$$(WASM_MAXIMUM_MEMORY_$1) -sABORTING_MALLOC=0
EH_OF_$1 = $$(EH_$$(WASM_SJLJ_$1))
endef

define ARCH_RULES
$$(B)/$1/config.mk: FORCE
	@mkdir -p $$(@D)
	@{ echo '# GENERATED by emscripten/Makefile: what $1 is built with'; \
	  echo 'EMCC = $$(EMCC)'; \
	  echo 'CFLAGS = $$(CFLAGS_$1)'; \
	  echo 'LDFLAGS = $$(COMMON_LDFLAGS_$1)'; \
	  echo 'EH = $$(EH_OF_$1)'; } >$$@.tmp
	@if cmp -s $$@.tmp $$@; then rm $$@.tmp; else mv $$@.tmp $$@; fi

$$(B)/$1/obj/%.o: $$(SRCDIR)/%.c $$(B)/$1/config.mk
	@mkdir -p $$(@D)
	$$(EMCC) $$(CFLAGS_$1) -MMD -MP -c $$< -o $$@

$$(B)/$1/obj/%.o: $$(EMDIR)/%.c $$(B)/$1/config.mk
	@mkdir -p $$(@D)
	$$(EMCC) $$(CFLAGS_$1) -MMD -MP -c $$< -o $$@

$$(B)/$1/liblua.a: $$(addprefix $$(B)/$1/obj/,$$(LUA_LIB_O))
	rm -f $$@
	$$(EMAR) crs $$@ $$^

$$(B)/$1/node/lua.js: $$(B)/$1/obj/lua.o $$(B)/$1/liblua.a
	@mkdir -p $$(@D)
	$$(EMCC) $$(COMMON_LDFLAGS_$1) $$(NODE_LDFLAGS) $$^ -o $$@ -lm

# a sh wrapper, so that build/A/node/lua runs like the native lua, from
# any working directory
$$(B)/$1/node/lua: $$(B)/$1/node/lua.js
	{ echo '#!/bin/sh'; \
	  echo '# GENERATED by emscripten/Makefile: Lua 5.5 ($1) under node'; \
	  echo 'd=$$$$(cd "$$$$(dirname "$$$$0")" && pwd)'; \
	  echo 'exec "$$$${NODE:-node}" $$$${NODE_OPTIONS_WASM} "$$$$d/lua.js" "$$$$@"'; } >$$@.tmp
	chmod +x $$@.tmp
	mv $$@.tmp $$@

$$(B)/$1/web/lua-repl.js: $$(B)/$1/obj/webrepl-main.o $$(B)/$1/liblua.a $$(NOTEBOOK_LUA)
	@mkdir -p $$(@D)
	$$(EMCC) $$(COMMON_LDFLAGS_$1) $$(WEB_LDFLAGS) $$(B)/$1/obj/webrepl-main.o $$(B)/$1/liblua.a \
	  --embed-file $$(NOTEBOOK_LUA)@/lua-web/notebook.lua -o $$@ -lm

-include $$(wildcard $$(B)/$1/obj/*.d)
endef

$(foreach a,$(ALL_ARCHS),$(eval $(call ARCH_VARS,$a)))
$(foreach a,$(ALL_ARCHS),$(eval $(call ARCH_RULES,$a)))


# the page: build/web/

WEB_ASSETS = repl.js repl-worker.js repl-driver.js notebook.css notebook-lib.js nb-kernel.js notebook.js
WEB_COPIES = $(addprefix $(B)/web/,$(WEB_ASSETS))
WEB_MODULES = $(B)/web/lua-repl.js $(foreach a,$(OTHERS),$(B)/web/$a/lua-repl.js)

$(WEB_COPIES): $(B)/web/%: $(EMDIR)/web/%
	@mkdir -p $(@D)
	cp $< $@

$(B)/web/lua-repl.js: $(B)/$(PRIMARY)/web/lua-repl.js
	@mkdir -p $(@D)
	cp $(B)/$(PRIMARY)/web/lua-repl.wasm $(@D)/
	cp $< $@

define WEB_OTHER_RULE
$$(B)/web/$1/lua-repl.js: $$(B)/$1/web/lua-repl.js
	@mkdir -p $$(@D)
	cp $$(B)/$1/web/lua-repl.wasm $$(@D)/
	cp $$< $$@
endef
$(foreach a,$(OTHERS),$(eval $(call WEB_OTHER_RULE,$a)))

LUA_VERSION := $(shell for n in MAJOR MINOR RELEASE; do \
  sed -n "s/^\#define LUA_VERSION_$${n}_N[[:space:]][[:space:]]*\([0-9][0-9]*\).*/\1/p" $(SRCDIR)/lua.h; \
  done | paste -sd. -)
WEB_BUILDS = $(foreach a,$(WASM_WEB_ARCHS),$a:$(EH_OF_$a))

# The page passes @BUILD@ as ?v= on every URL it loads, so that a browser
# never mixes cached files of two builds: the revision alone would not
# change between rebuilds of an uncommitted tree, hence the checksum over
# every copied file and every module.  The directories of architectures
# no longer listed go.  index.html is rewritten only when it changes.
$(B)/web/index.html: $(EMDIR)/web/index.html $(WEB_COPIES) $(WEB_MODULES) FORCE
	@mkdir -p $(@D)
	for a in wasm64 wasm32; do \
	  case " $(OTHERS) " in *" $$a "*) ;; *) rm -rf $(B)/web/$$a ;; esac; \
	done
	rev=$$(git -C $(SRCDIR) rev-parse --short HEAD 2>/dev/null || echo dev); \
	  sum=$$(cat $(WEB_COPIES) $(WEB_MODULES) $(B)/web/lua-repl.wasm \
	    $(foreach a,$(OTHERS),$(B)/web/$a/lua-repl.wasm) | cksum | cut -d' ' -f1); \
	  sed -e "s/@BUILD@/$$rev-$$sum/g" -e "s/@ARCH@/$(PRIMARY)/g" -e "s/@EH@/$(EH_OF_$(PRIMARY))/g" \
	    -e "s/@BUILDS@/$(strip $(WEB_BUILDS))/g" -e "s/@VERSION@/$(LUA_VERSION)/g" $< >$@.tmp
	if cmp -s $@.tmp $@; then rm $@.tmp; else mv $@.tmp $@; fi


# goals

.PHONY: all web node lib smoke testes harness check page-test serve clean FORCE

all: web
web: $(B)/web/index.html
node: $(foreach a,$(WASM_ARCHS),$(B)/$a/node/lua)
lib: $(foreach a,$(ALL_ARCHS),$(B)/$a/liblua.a)

# Every path is absolute: both scripts change directory.
smoke: node
	for a in $(WASM_ARCHS); do \
	  NODE="$(NODE)" WASM_ARCH=$$a LUA=$(B)/$$a/node/lua sh $(EMDIR)/tests/wasm-smoke.sh || exit 1; \
	done

testes: node
	for a in $(WASM_ARCHS); do \
	  NODE="$(NODE)" WASM_ARCH=$$a LUA=$(B)/$$a/node/lua LUA_JS=$(B)/$$a/node/lua.js \
	    IN_WORKER=$(EMDIR)/tests/wasm/in-worker.js TESTES=$(SRCDIR)/testes OUT=$(B)/$$a/testes \
	    PRELUDE=$(EMDIR)/tests/testes-prelude.lua sh $(EMDIR)/tests/run-testes.sh || exit 1; \
	done

# The harnesses of the page's modules: each in default node and with
# unoptimised code and a stack near a browser worker's.  The jsc lane
# runs the wasm32 module in JavaScriptCore's shell, with the stack of a
# Darwin worker (512 KB, as on iOS) and with less, only when JSC is set.
HARNESS = $(EMDIR)/tests/wasm
SLOW_NODE = $(NODE) --liftoff --no-wasm-tier-up --stack-size=900
JSC_DIR = $(if $(filter wasm32,$(PRIMARY)),$(B)/web,$(if $(filter wasm32,$(OTHERS)),$(B)/web/wasm32))

harness: web
	$(NODE) $(HARNESS)/lib-harness.js
	for a in $(WASM_WEB_ARCHS); do \
	  $(NODE) $(HARNESS)/repl-harness.js $(B)/web --arch=$$a && \
	  $(SLOW_NODE) $(HARNESS)/repl-harness.js $(B)/web --arch=$$a && \
	  $(NODE) $(HARNESS)/notebook-harness.js $(B)/web --arch=$$a && \
	  $(SLOW_NODE) $(HARNESS)/notebook-harness.js $(B)/web --arch=$$a && \
	  $(NODE) $(HARNESS)/worker-harness.js $(B)/web --arch=$$a || exit 1; \
	done
ifneq ($(and $(JSC),$(JSC_DIR)),)
	for b in 524288 393216; do \
	  $(JSC) --maxPerThreadStackUsage=$$b $(HARNESS)/jsc-stack.js -- $(JSC_DIR) \
	    $(EMDIR)/web/repl-driver.js || exit 1; \
	done
endif

check:
	$(MAKE) -f $(EMDIR)/Makefile smoke
	$(MAKE) -f $(EMDIR)/Makefile testes
	$(MAKE) -f $(EMDIR)/Makefile harness

# needs PLAYWRIGHT_MODULE or a resolvable "playwright"
page-test: web
	$(NODE) $(HARNESS)/page.spec.mjs $(B)/web

serve: web
	cd $(B)/web && $(PYTHON) $(EMDIR)/deploy/serve.py

clean:
	rm -rf $(B)

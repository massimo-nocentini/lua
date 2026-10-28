# Lua in WebAssembly: console and notebook

Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in `lua.h`).

This directory builds the unmodified Lua interpreter of this tree with [Emscripten](https://emscripten.org) for
WebAssembly, in two architectures (wasm64 and wasm32), and a web page that runs it entirely in the browser with two
interfaces:

- **Console**: Lua's interactive mode, a port of `lua.c`'s REPL (banner, `>`/`>>` prompts, `_PROMPT`, `return
  <line>` first, tracebacks, `-e`/`-l`/`-W`/`-E`, `LUA_INIT`, `io.read` from what you type, Stop with Esc).
- **Notebook**: code and Markdown cells, a kernel of its own (the same module started as `lua --notebook`), rich
  output through the `notebook` module (HTML, SVG, Markdown, tables, images), export and import as `.lua`, `.json`
  and static `.html`.

The deployed page is <https://massimo-nocentini.github.io/lua/> (GitHub Pages, from the `gh-pages` branch; see
[Deployment](#deployment)). `deploy/README.txt` is the user's side of this file; it is copied into the bundle.

Nothing here changes an upstream file: Lua's own sources, `makefile`, `manual/` and `testes/` are compiled and run
as they are, and every web-specific behaviour is installed at run time by the glue, which replaces library
functions in the Lua tables. `master` stays mergeable with upstream.

## Layout

```
emscripten/
  Makefile            the build (GNU make, emcc), self-contained; output in build/ only
  .gitignore          /build/
  webrepl.h           the C ABI the JavaScript side calls (states, prompt levels, exports)
  webrepl-main.c      the web module's main: console REPL, notebook kernel, the web replacements
  notebook.lua        the notebook module (rich output, the value formatter), embedded in the module
  web/                the page: index.html, repl.js (console, settings, build choice), repl-worker.js,
                      repl-driver.js, notebook.js, notebook-lib.js, nb-kernel.js, notebook.css
  deploy/             README.txt and serve.py, added to the deployed bundle
  tests/
    wasm-smoke.sh     the node build against the lua command line
    run-testes.sh     upstream testes/all.lua under the node build, plus the 1 MB worker lane
    testes-prelude.lua  two workarounds for that run (see Known issues)
    wasm/             node harnesses and the Playwright spec (see Tests)
.github/workflows/wasm-bundle.yml   build, test, deploy
```

Build output, never committed:

```
emscripten/build/
  wasm64/ wasm32/     config.mk, obj/, liblua.a, node/lua (+ lua.js, lua.wasm), web/lua-repl.{js,wasm}
  web/                the page: index.html and its scripts, lua-repl.{js,wasm} of the first architecture,
                      wasm32/lua-repl.{js,wasm} of the second
```

## Building

With [emsdk](https://emscripten.org/docs/getting_started/downloads.html) 6.0.10 (the version CI uses) installed
and activated:

```sh
source /path/to/emsdk/emsdk_env.sh
make -C emscripten -j"$(nproc)"          # the page, both architectures: emscripten/build/web
make -C emscripten serve                 # ... and serve it on http://localhost:8080/
```

| target | what it does |
|---|---|
| `all` (default), `web` | the web module of every architecture in `WASM_WEB_ARCHS`, and the page in `build/web/` |
| `node` | `build/A/node/lua`, a node build of the unmodified `lua.c`, for every `A` in `WASM_ARCHS` |
| `lib` | `build/A/liblua.a` (every `l*.c` but `lua.c` and `ltests.c`) |
| `smoke` | `tests/wasm-smoke.sh` on each node build |
| `testes` | upstream `testes/all.lua` on each node build, then `cstack.lua` and `errors.lua` in a 1 MB worker |
| `harness` | `lib-harness.js`, then `repl-harness.js`, `notebook-harness.js` (each in default node and with `--liftoff --no-wasm-tier-up --stack-size=900`) and `worker-harness.js` per architecture; the JavaScriptCore lane when `JSC` is set |
| `check` | `smoke testes harness` (what CI runs) |
| `page-test` | the Playwright spec on `build/web` (not part of `check`) |
| `serve` | `deploy/serve.py` on `build/web` |
| `clean` | `rm -rf build` |

Knobs (`make -C emscripten VAR=value`):

| variable | default | meaning |
|---|---|---|
| `WASM_WEB_ARCHS` | `wasm64 wasm32` | the page's builds; the first sits beside `index.html`, the others in `<arch>/` |
| `WASM_ARCHS` | `$(WASM_WEB_ARCHS)` | the architectures of `node`, `smoke` and `testes` |
| `WASM_SJLJ_wasm64`, `WASM_SJLJ_wasm32` | `wasm`, `wasm-legacy` | how Lua's `setjmp`/`longjmp` error handling is lowered: WebAssembly exceptions with exnref, legacy exceptions, or `emscripten` (JavaScript, slow, runs everywhere) |
| `WASM_MAXIMUM_MEMORY_wasm64`, `_wasm32` | 16 GiB, 2 GiB | the most memory a module may grow to (wasm32 pointers stay below 2^31) |
| `WASM_STACK_SIZE` | 1 MiB | the linear-memory C stack |
| `WASM_MAXCCALLS` | empty | if set, `-DLUAI_MAXCCALLS=n` (a define, not a source change): the remedy if a stack lane shows Lua's 200 C levels overflowing an engine's stack |
| `WASM_INITIAL_MEMORY` | 16 MiB | |
| `WASM_DEBUG` | | `1`: `-g -O0`, assertions and stack overflow checks |
| `NODE` | `$EMSDK_NODE`, else `node` | the node for the tests (wasm64 needs memory64: node 24, which emsdk brings) |
| `JSC` | | a JavaScriptCore shell, for the local jsc lane of `harness` |

Lua is compiled with `-DLUA_USE_POSIX` only. `lua_Integer` is 64-bit on both architectures; `size_t` is 64-bit on
wasm64 and 32-bit on wasm32 (`string.packsize("T")` tells them apart). wasm32 is about 1.5x faster; wasm64 can use
more than 4 GB.

## How it works

The page starts each interpreter in a Web Worker (one for the Console, one for the Notebook kernel). The module
never blocks the worker, and nothing needs `SharedArrayBuffer` (so no COOP/COEP headers, which GitHub Pages cannot
send): the glue in `webrepl-main.c` runs Lua in **time slices** of about 50 ms.

- **Slicing.** Every chunk (a console line, a startup job, a cell) runs in a *runner* coroutine whose body is a C
  function calling the chunk with `lua_pcallk`, with `lua.c`'s message handler. A count hook (every 1000
  instructions) yields the runner when the slice is over; `webrepl_resume()` resumes it in the next slice. The
  JavaScript driver (`web/repl-driver.js`) pumps slices with zero-delay tasks, so the worker handles messages (input,
  Stop, acks) between them. Coroutines that user code creates inherit the hook; the replacements of
  `coroutine.resume`/`wrap` forward a slice yield from an inner coroutine out to the runner and back. Code inside a
  C call that cannot yield (a `table.sort` comparator, a `gsub` callback, a metamethod called by a C library
  function, such as the `__tostring` of `string.format("%s", v)`) is not sliced. The glue's own `tostring` and
  `print` call `__tostring` from Lua, so those, and the formatting of a cell's values, are sliced and stoppable.
- **States.** `webrepl_resume()` returns `WAITING` (the REPL waits for a line, or Lua code for input), `BUSY` (more
  work), `SLEEPING` (`notebook.sleep`), `IDLE` (the kernel waits for a request) or `EXITED`, and
  `webrepl_prompt()` tells a `>` prompt (1) from a `>>` one (2) and from a read (0).
- **Input.** What the page sends is queued in C and read only through musl's `stdin`, by the REPL's line reader and
  by `io.read`/`io.lines` alike, so a paste mixing code and data stays in order. A read that has no input yet
  yields the runner (`WAITING`) and is retried when input arrives. One end of file (Ctrl+D) ends one read, as on a
  tty; at the prompt it ends the session. In the kernel, input sent before a cell starts is kept for it, and what
  a cell leaves unread is dropped when it ends, so it never reaches the next cell.
- **Output.** fds 1 and 2 are replaced at the stream level and reach `onOutput` as bytes; stdout is line buffered,
  stderr unbuffered; a write to stderr flushes stdout first, so the two keep their order. fd 3 carries the kernel's events (JSON lines), fd 4 the prompt. The worker coalesces output and
  stops pumping while more than 1 MiB is unacknowledged by the page.
- **Stop.** `webrepl_interrupt()` sets a flag and arms the hook with count 1; the hook raises `interrupted!`, as
  `lua.c`'s SIGINT handler does, so `pcall` loops and `__close` handlers behave as natively. A Stop that gets no
  message back within 3 s (code stuck inside one C call) makes the page kill the worker and start a new one
  (`-- interpreter restarted (state lost)`). `notebook.sleep(s)` returns to the driver at least every 50 ms, so a
  Stop during a long sleep is seen at once.
- **`debug.sethook`** replaces the slicing hook on that thread only (slicing and Stop are lost there while it is
  set); clearing it restores the glue's hook at once, and `debug.gethook` never shows the glue's. A hook still set
  when a line, job or cell ends is set again on the runner of the next one, as `lua.c` keeps it on its one thread.
- **Exit.** `os.exit` flushes, optionally closes the state, and calls `exit()`, which emscripten turns into an
  `ExitStatus` exception the driver reports as `onExit(code)`.
- **The notebook kernel** reads requests (`run RID NAME\nSOURCE`, `ping RID`) from a mailbox and answers with
  events (`hello`, `start`, `display`, `clear`, `done`, ...). A cell is compiled as `return <src>;` first, then
  with its last lines as the returned expression, so `x = 10` followed by `x * 2` shows `20`, and
  `function f() ... end` followed by `f()` shows what `f` returns. When the cell compiles as is, that split is
  taken only if it keeps the cell's meaning: a `;` put before the last lines must give the same bytecode, so
  `x = f` followed by `(1)` (the call `x = f(1)`) runs as is and shows nothing. Otherwise the cell runs as is, and
  shows only what an explicit `return` gives. Values are formatted by `notebook.lua` (`K.repr`), sliced and
  stoppable like the cell itself.

The full contracts (ABI, states, the page and worker protocol, the kernel protocol) are in the comments at the top
of `webrepl-main.c`, `web/repl-driver.js`, `web/repl-worker.js` and `web/nb-kernel.js`.

## Tests

```sh
source /path/to/emsdk/emsdk_env.sh
make -C emscripten check NODE="$EMSDK_NODE"
```

runs, for both architectures:

- `tests/wasm-smoke.sh`: the node build against `lua`'s command line;
- `tests/run-testes.sh`: upstream `testes/all.lua` (`final OK`), and `cstack.lua` and `errors.lua` again in a
  worker thread with a 1 MB stack and unoptimised code (`tests/wasm/in-worker.js`), as a browser worker has;
- `tests/wasm/lib-harness.js`: `web/notebook-lib.js` (highlighter, balance, quotes, file formats) in node;
- `tests/wasm/repl-harness.js`: the console, case by case against the native `lua`'s exact output;
- `tests/wasm/worker-harness.js`: `web/repl-worker.js` unmodified in a 1 MB worker thread, playing the page;
- `tests/wasm/notebook-harness.js`: the kernel protocol, then `web/nb-kernel.js` against the real worker.

Each harness takes `WEB_DIR --arch=A` and prints `ok - N` / `not ok - N` lines; `--only=REGEXP` runs some cases.
`tests/wasm/wasm-arch.js FILE.wasm` says which architecture a module is.

**JavaScriptCore** (Safari, every iOS browser) runs wasm32 with larger frames on a 512 KB worker stack. With a
`jsc` shell (WebKit's `Tools/Scripts/generate-bundle --bundle=jsc`, or macOS's JavaScriptCore.framework),
`make -C emscripten harness JSC=/path/to/jsc` adds `tests/wasm/jsc-stack.js` at 524288 and 393216 bytes: deep C
recursions must end in Lua's `C stack overflow`. CI has no jsc; it runs the page in Playwright's WebKit instead.

**The page** in real browsers, with [Playwright](https://playwright.dev) (a test tool only: it is installed outside
the repository, which has no `package.json`):

```sh
npm install --no-save --prefix /some/dir playwright@1.64.0
/some/dir/node_modules/.bin/playwright install chromium firefox     # webkit too, if you like
make -C emscripten page-test PLAYWRIGHT_MODULE=/some/dir/node_modules/playwright
# or on any bundle:  BROWSERS=chromium,firefox node emscripten/tests/wasm/page.spec.mjs emscripten/build/web
```

`tests/wasm/page.spec.mjs` serves the page with node's `http` and tests, per browser, the default page and
`?arch=wasm32`: startup and the build chip, the console (evaluation, history, `>>` continuation lines, values,
`print`, errors, Stop by Esc, Ctrl+C and button, input, upload, deep C recursion, Restart, settings, theme, smart
quotes, the build switch), the notebook (the example notebook and Run all, text cells, rich output: SVG, HTML,
markdown, tables; the sanitizer, the highlighter, Stop, Restart, the stdin box, export and import, persistence),
narrow viewports, accessibility, and that the page fetches nothing outside its origin. `SHOTS=dir` saves
screenshots (also of every failed check), `ONLY=regexp` runs some checks, `QUERIES='?arch=wasm64,?arch=wasm32'`
tests those pages instead, and `PAGE_URL=http://localhost:8080/` tests a server already running (such as
`serve.py` in a bundle) instead of its own.

## Deployment

`.github/workflows/wasm-bundle.yml` runs on every push and pull request to `master`:

1. **bundle**: installs emsdk 6.0.10 (cached), builds both architectures, runs `make check`, assembles
   `build/web` plus `deploy/README.txt` and `deploy/serve.py`, and uploads it as the artifact
   `lua-wasm-web-<rev>`;
2. **page**: runs `page.spec.mjs` on that artifact in Chromium and Firefox (and, informationally, WebKit);
3. **deploy** (pushes to `master` only, after both): replaces the `gh-pages` branch with **one new commit** holding
   the bundle in `docs/` (plus `docs/.nojekyll`), force-pushed with a lease. Its `Source:` trailer names the commit
   of `master` it was built from; a run of an older commit than the one deployed (a re-run) deploys nothing, and so
   does an identical bundle. It then asks GitHub Pages for a build.

**`gh-pages` is generated output.** Never edit it by hand: every deploy replaces the whole branch, so a change made
there is lost. The page's sources are `emscripten/web/` (and the C glue here) on `master`; change them there.

One-time setup, in the repository's Settings:
- *Pages* › Build and deployment › Source: **Deploy from a branch**, branch **gh-pages**, folder **/docs** (the
  branch exists after the first deploy);
- *Actions* › General › Workflow permissions: the workflow asks for `contents: write` and `pages: write` itself, in
  its deploy job only.

## Known issues

- **wasm64 and `lstrlib.c`'s `getnumlimit`.** Upstream passes a `size_t` to a `%d` in `"integral size (%d) out of
  limits [1,%d]"` (`string.pack("i17", 1)`, for instance). On wasm64 the varargs slot of a `size_t` is 8 bytes and
  the first `%d` reads only 4 of them, so the second `%d` reads the other 4: the message ends `[1,0]` instead of
  `[1,16]`. On x86-64 and on wasm32 the same undefined behaviour happens to print the right text. The check itself
  works; only the message is wrong. `tests/testes-prelude.lua` skips the one assertion of `tpack.lua` that compares
  that text, on wasm64 only. The fix belongs upstream (`(int)sz`).
- **Locales.** emscripten's musl accepts any `os.setlocale` name without effect, so the prelude makes the testes
  see only `C`.
- No C modules (`package.loadlib`), no `io.popen`; `os.execute` returns `nil, "Function not implemented", 52`.
- Files live in MEMFS for one session.

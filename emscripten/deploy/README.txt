Lua 5.5 console and notebook in WebAssembly (wasm64 and wasm32)
===============================================================

The unmodified Lua interpreter, built with Emscripten for WebAssembly,
running entirely in your browser: a Console tab (the lua command-line
REPL) and a Notebook tab (code and Markdown cells with rich output).
Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
Copyright Notice in lua.h).

This directory is a generated copy of emscripten/build/web from
  make -C emscripten web WASM_WEB_ARCHS="wasm64 wasm32"
which has two builds: wasm64 (64-bit WebAssembly) beside index.html,
and wasm32 (32-bit) in wasm32/.  The page picks one when it loads.

On the gh-pages branch (docs/) this directory is replaced by every
deploy of the "WebAssembly bundle" workflow, which force-pushes a single
new commit: never edit it there by hand, the change would be lost.  The
sources are emscripten/web/ (and the C glue in emscripten/) on master.

Run it locally
  1. In this directory run:   python3 serve.py        (or: python3 serve.py 9000)
  2. Open http://localhost:8080/ if a browser does not open by itself.

  Any static web server works, e.g.  python3 -m http.server 8080, as
  long as it sends .wasm files as application/wasm.  No special headers
  (COOP/COEP) are needed.  Opening index.html directly (file://) does
  NOT work: browsers do not run workers or load .wasm files from file://
  URLs.  Once loaded the page makes no request outside its own origin,
  so it also works offline from a local copy.

Browser requirements
  wasm64 needs 64-bit WebAssembly (memory64) and standard WebAssembly
  exception handling (exnref): Chrome or Edge 137+, Firefox 134+.
  wasm32 needs the legacy exception handling instructions only: Chrome
  or Edge 95+, Firefox 100+, Safari 15.4+.  Where wasm64 cannot run the
  page runs wasm32, and says so in the console ("-- running the wasm32
  build: ...").  Without either the page says what is missing.  The
  header shows the build running.  wasm32 is about 1.5x faster; wasm64
  can use more than 4 GB of memory.  Firefox may warn in its console
  that the legacy exception handling of wasm32 is deprecated; it still
  works.

  To ask for a build, add ?arch=wasm32 or ?arch=wasm64 to the URL
  (?arch=auto for the automatic choice), or choose it under
  "WebAssembly build" in the Settings (kept in the browser; the URL
  overrides it).  A build the browser cannot run is ignored, with a note
  in the console.

Using the Console
  It is lua's interactive mode: an expression prints its values, a
  statement runs, an unfinished one continues at the ">>" prompt.
  Enter evaluates, Shift+Enter adds a line, Up/Down recall history,
  Tab indents.  Esc (or Ctrl+C with no selection, or the Stop button)
  stops a running chunk with "interrupted!", as Ctrl+C does in a
  terminal; at ">>" it discards the unfinished statement.  Ctrl+D on an
  empty line sends end of file: to io.read() it ends that read only, at
  the prompt it ends the session.  Ctrl+L clears the screen.  io.read()
  and io.lines() read what you type; the status pill says "waiting for
  input" then.
  Upload        puts files in the home directory (/home/web_user), the
                current directory of the interpreter: run them with
                dofile("name.lua"), or require "name" for a module.
                Uploads survive a Restart.
  Restart       a fresh interpreter (globals are lost, uploads kept).
  Settings      the init code, lua options, the time slice, smart
                quotes, the theme and the build.

Using the Notebook
  Code and Markdown cells.  Shift+Enter runs a cell and moves on,
  Ctrl+Enter runs it in place, Alt+Enter runs it and adds a cell below;
  Esc leaves the editor, and then j/k move, a/b add a cell above/below,
  d d deletes, m/y make a Markdown/code cell, i i stops, 0 0 restarts
  the kernel, ? lists the shortcuts.  Run all, Stop, Restart and
  "Restart & run all" are in the toolbar.  A cell shows the values of
  its last expression (x = 10 then x * 2 on the next line shows 20);
  globals persist from cell to cell, locals do not.  Errors show their
  traceback, with links to the cells' lines.  The notebook is saved in
  the browser; Export/Import has .lua (cells as "-- %%" sections), .json
  and .html (a static page with no scripts), and the example notebook.

The notebook module
  notebook = require "notebook" (a global already in the Notebook) gives
  rich output:
    notebook.html(s or tree)    notebook.svg(tree)    notebook.markdown(s)
    notebook.table(rows [, header])    notebook.image(png_bytes or path)
    notebook.text(x)    notebook.show(x [, id])    notebook.clear()
    notebook.markup(tree)    notebook.raw(s)    notebook.escape(s)
    notebook.repr(x)    notebook.sleep(seconds)
  A tree is {"tag", attr = value, child, ...}, e.g.
    notebook.svg{"svg", viewBox = "0 0 10 10",
                 {"rect", width = 10, height = 10, style = "fill: var(--accent)"}}
  notebook.show(x, "p") again with the same id replaces that output in
  place (a progress bar).  In the Console a display prints a one-line
  note instead.  HTML and SVG are sanitized: no scripts, no event
  handlers, no external resources.

The init code (LUA_INIT)
  Settings > Init code is run before the first prompt, as lua runs the
  LUA_INIT environment variable: Lua code, or @name.lua for an uploaded
  file.  The notebook kernel runs it too, before the first cell.  The -E
  option (Settings > Arguments) ignores it.

Limits
  - Files live in an in-memory file system (MEMFS) that lasts one
    session: a Restart or a reload loses what Lua wrote (uploads are
    sent again).
  - No C modules (package.loadlib, require of a .so), no io.popen, and
    os.execute returns nil, "Function not implemented".  os.setlocale
    accepts names without effect.
  - Lua runs in time slices, so Stop and input work without blocking the
    page.  debug.sethook replaces the slicing hook on that thread: while
    a hook of your own is set, that coroutine is not sliced and cannot
    be stopped (clearing it with debug.sethook() restores both).
  - Code inside a C call (a sort comparator, a gsub callback, a
    __tostring called from C, require) cannot wait for input and is not
    sliced; if Stop gets no answer within 3 s the interpreter is
    restarted ("-- interpreter restarted (state lost)").
  - Smart quotes: with Settings > Straighten smart quotes (on by default
    on phones), quotes typed by phone keyboards become straight ones.
    In a string opened with a curly single quote an apostrophe ends it
    (it's would end the string): open such strings with a straight
    quote.

Files
  index.html, repl.js, repl-worker.js, repl-driver.js,
  notebook.js, notebook-lib.js, nb-kernel.js, notebook.css   the page
  lua-repl.js / .wasm      the Lua interpreter and notebook kernel (wasm64)
  wasm32/                  the same module, built for wasm32
  README.txt, serve.py     this file, and a local server

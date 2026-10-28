#!/usr/bin/env python3
# Part of the WebAssembly/Docker port of Lua; same license as Lua (see the
# Copyright Notice in lua.h).
"""Serve the Lua WebAssembly page on http://localhost:8080/ (or the port given).

Browsers run neither workers nor .wasm files from file:// URLs, so the page
needs a web server; any static one works, this one only makes sure that .wasm
is sent as application/wasm (which WebAssembly.compileStreaming requires) and
.js as text/javascript.  It sends no COOP/COEP headers: the page does not use
SharedArrayBuffer (Lua runs in time slices instead), so it needs no
cross-origin isolation, exactly as on GitHub Pages, which cannot send them.
It listens on 127.0.0.1 only.
"""
import http.server, socketserver, os, sys, webbrowser

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
# In the bundle this file sits beside index.html; "make -C emscripten serve"
# runs it from emscripten/deploy inside build/web, which is then the page.
here = os.path.dirname(os.path.abspath(__file__))
if os.path.isfile(os.path.join(here, 'index.html')):
    os.chdir(here)

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript'}

with socketserver.TCPServer(('127.0.0.1', port), Handler) as httpd:
    url = f'http://localhost:{port}/'
    print(f'Lua console and notebook at {url}  (Ctrl-C to stop)')
    try: webbrowser.open(url)
    except Exception: pass
    try: httpd.serve_forever()
    except KeyboardInterrupt: pass

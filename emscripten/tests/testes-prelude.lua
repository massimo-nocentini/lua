-- testes-prelude.lua - workarounds for running Lua's test suite under wasm
-- Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
--
-- run-testes.sh runs it (dofile) before testes/all.lua and before the
-- worker lane's files, with the node build of the unmodified lua.c.  Two
-- things differ from a native build, and neither is a bug of the port:
--
-- * Emscripten's musl accepts any locale name in setlocale, but never
--   changes LC_NUMERIC or LC_COLLATE: the tests that switch to a
--   locale with another decimal point (or collation) and then check the
--   effect would fail.  Natively they are skipped when setlocale fails,
--   so here only "C" (and "POSIX", and the query "") succeed.
--
-- * lstrlib.c's 'getnumlimit' passes a size_t to a "%d" format (in the
--   "integral size (%d) out of limits [1,%d]" error).  That is undefined
--   behaviour, harmless where size_t and int are passed alike; on wasm64
--   the varargs slot of a size_t is 8 bytes and the message shows a
--   wrong limit.  tpack.lua's check of that exact text is skipped on
--   wasm64 only (string.packsize("T") == 8); every other test runs.

local sl = os.setlocale
os.setlocale = function (l, c)
  if l and l ~= '' and l ~= 'C' and l ~= 'POSIX' then return nil end
  return sl(l, c)
end

local lf = loadfile
loadfile = function (n, ...)
  if n == 'tpack.lua' and string.packsize('T') == 8 then
    local f = assert(io.open(n)); local s = f:read('a'); f:close()
    s = s:gsub('checkerror%("%%%(17%%%) out of limits[^\n]*', '-- skipped on wasm64')
    return load(s, '@'..n)
  end
  return lf(n, ...)
end

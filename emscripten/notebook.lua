-- notebook.lua - rich output for the Lua notebook (see emscripten/README.md)
-- Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).

--[[
The web module embeds this file at /lua-web/notebook.lua.  webrepl-main.c
loads it (mode "t") and calls it with one argument, the table `core` of C
primitives:

  core.display(mime, data [, id])  emit a display (kernel), or print a
                                   placeholder line (console)
  core.clear()                     remove the current cell's outputs
  core.sleep(seconds)              yield the slice for that long (it is
                                   notebook.sleep itself)
  core.base64(s)                   standard base64, padded, no line breaks
  core.kernel, core.arch, core.version

The chunk returns M, the module `notebook` (package.loaded.notebook, and
the global `notebook` in the kernel), and K, the two functions the kernel
calls on a cell's results:

  K.display(v) -> mime, data, nil   for a display object, or an element
                                    tree whose root is <svg>; nothing for
                                    any other value
  K.repr(v)    -> string            the value as the notebook prints it

Everything this file calls is captured below, when it is loaded: a cell may
assign `print = nil; tostring = nil; string = nil` and the next cell still
gets its values formatted.  Table traversal is raw (rawget, next), so
formatting a value never runs its __index or __pairs; only __tostring and
__name are honoured, through the original tostring, as lauxlib does.

Display objects and raw-markup markers are empty tables whose data lives in
weak tables private to this file, so user code can neither forge one nor
change one.  Their metatables are protected (__metatable).

Arguments are checked as lauxlib does.  An error found deep inside an
element tree is raised as a private object and turned into the
"bad argument #n to 'f' (...)" text by the API function's wrapper, so that
its position is the caller's, as luaL_argerror gives it.
]]

local core = ...

local type, tostring, select, next, rawget, rawlen, error, pcall, setmetatable, ipairs =
      type, tostring, select, next, rawget, rawlen, error, pcall, setmetatable, ipairs
local getmt = (debug and debug.getmetatable) or getmetatable
local sub, find, byte, format, gsub, gmatch, lower, concat, sort =
      string.sub, string.find, string.byte, string.format, string.gsub, string.gmatch, string.lower,
      table.concat, table.sort
local mathtype, floor = math.type, math.floor
local io_open = io.open

local core_display, core_clear, core_base64 = core.display, core.clear, core.base64

local M, K = {}, {}


-- ---- argument errors

-- raised by the helpers, caught by the wrappers below
local ARGERR = {}

local function argerr(n, msg)
  error(setmetatable({ n = n, msg = msg }, ARGERR), 0)
end

-- luaL_typename, with __name as luaL_typeerror uses it
local function typename(v)
  local mt = getmt(v)
  local name = type(mt) == 'table' and rawget(mt, '__name')
  if type(name) == 'string' then return name end
  return type(v)
end

-- argument N of a call with NARGS arguments was V and not EXPECTED
local function typeerr(n, nargs, v, expected)
  argerr(n, expected .. ' expected, got ' .. (n > nargs and 'no value' or typename(v)))
end

local function rethrow(name, ok, ...)
  if ok then return ... end
  local e = ...
  if getmt(e) == ARGERR then
    -- level 2: the frame below this one is the caller of the API
    -- function, which tail-called rethrow
    error(format("bad argument #%d to '%s' (%s)", e.n, name, e.msg), 2)
  end
  error(e, 0)
end

-- the public function NAME: IMPL gets the number of arguments first
local function api(name, impl)
  return function (...)
    return rethrow(name, pcall(impl, select('#', ...), ...))
  end
end


-- ---- display objects and raw markup

local objs = setmetatable({}, { __mode = 'k' })   -- display object -> {mime, data}
local raws = setmetatable({}, { __mode = 'k' })   -- raw marker -> markup

local function readonly() error('notebook objects are read-only', 2) end

local DISPLAY = {
  __name = 'notebook.display',
  __metatable = 'notebook.display',
  __index = function (o, k)
    local d = objs[o]
    if k == 'mime' then return d[1] elseif k == 'data' then return d[2] end
    return nil
  end,
  __newindex = readonly,
  __tostring = function (o)
    local d = objs[o]
    return format('notebook.display: %s %d bytes', d[1], #d[2])
  end,
}

local RAW = {
  __name = 'notebook.raw',
  __metatable = 'notebook.raw',
  __newindex = readonly,
  __tostring = function (o) return format('notebook.raw: %d bytes', #raws[o]) end,
}

local function mkdisplay(mime, data)
  local o = setmetatable({}, DISPLAY)
  objs[o] = { mime, data }
  return o
end

local function isdisplay(x) return type(x) == 'table' and objs[x] ~= nil end


-- ---- the value formatter (K.repr, notebook.repr)

local RESERVED = {}
for w in gmatch('and break do else elseif end false for function goto if in local nil not or repeat return then true until while', '%a+') do
  RESERVED[w] = true
end

-- the other control bytes are written \ddd
local ESCAPES = { [9] = '\\t', [10] = '\\n', [13] = '\\r' }

-- the length of the valid UTF-8 sequence at s[j] (a byte >= 0x80), or nil
-- (RFC 3629: no overlong forms, no surrogates, nothing above U+10FFFF)
local function u8len(s, j)
  local b = byte(s, j)
  if b < 0xC2 then return nil end
  if b < 0xE0 then
    local c = byte(s, j + 1)
    return c and c >= 0x80 and c <= 0xBF and 2 or nil
  end
  local lo, hi = 0x80, 0xBF
  if b < 0xF0 then
    local c1, c2 = byte(s, j + 1, j + 2)
    if not c2 then return nil end
    if b == 0xE0 then lo = 0xA0 elseif b == 0xED then hi = 0x9F end
    return c1 >= lo and c1 <= hi and c2 >= 0x80 and c2 <= 0xBF and 3 or nil
  end
  if b < 0xF5 then
    local c1, c2, c3 = byte(s, j + 1, j + 3)
    if not c3 then return nil end
    if b == 0xF0 then lo = 0x90 elseif b == 0xF4 then hi = 0x8F end
    return c1 >= lo and c1 <= hi and c2 >= 0x80 and c2 <= 0xBF and c3 >= 0x80 and c3 <= 0xBF and 4 or nil
  end
  return nil
end

-- The output buffer.  Once MAX bytes would be passed, it keeps what fits,
-- cut at a character boundary, ends in "…" and ignores the rest: then
-- st.full is set and the walkers below stop early, so formatting a huge
-- value costs about MAX, not its size.
local ELLIPSIS = '\226\128\166'

-- the first bytes of S, at most LEN, not ending inside a UTF-8 sequence
local function cut(s, len)
  while len > 0 do
    local b = byte(s, len + 1)
    if not b or b < 0x80 or b >= 0xC0 then break end
    len = len - 1
  end
  return sub(s, 1, len)
end

local function put(st, s)
  if st.full then return end
  if st.size + #s <= st.max then
    st.n = st.n + 1
    st[st.n] = s
    st.size = st.size + #s
    return
  end
  -- what is kept and the ellipsis take at most MAX bytes: S, or the
  -- pieces already there, are cut to make room for it
  local limit = st.max - #ELLIPSIS
  if st.size < limit then
    st.n = st.n + 1
    st[st.n] = cut(s, limit - st.size)
    st.size = st.size + #st[st.n]
  end
  while st.size > limit do
    local last = st[st.n]
    local keep = cut(last, #last - (st.size - limit))
    st.size = st.size - #last + #keep
    st[st.n] = keep
    if keep == '' then st.n = st.n - 1 end
  end
  st.n = st.n + 1
  st[st.n] = ELLIPSIS
  st.size = st.size + #ELLIPSIS
  st.full = true
end

-- the bytes reprstring copies as they are stop at these
local SPECIAL = '[%c"\\\128-\255]'

local function reprstring(st, s)
  put(st, '"')
  local i, n = 1, #s
  while i <= n and not st.full do
    local j = find(s, SPECIAL, i)
    local e = (j or n + 1) - 1
    if e >= i then
      -- never more than fits: a 5 MB string is not copied to show 64 KB
      -- (one byte more than fits makes put end the output)
      local room = st.max - st.size
      if e - i + 1 > room then e = i + room end
      put(st, sub(s, i, e))
      i = e + 1
      if st.full then break end
    end
    if not j then break end
    local b = byte(s, j)
    if b == 34 then put(st, '\\"'); i = j + 1
    elseif b == 92 then put(st, '\\\\'); i = j + 1
    elseif ESCAPES[b] then put(st, ESCAPES[b]); i = j + 1
    elseif b < 32 or b == 127 then
      -- \ddd: three digits when a digit follows, so that it reads back
      local nb = byte(s, j + 1)
      put(st, (nb and nb >= 48 and nb <= 57) and format('\\%03d', b) or '\\' .. b)
      i = j + 1
    else
      local len = u8len(s, j)
      if len then put(st, sub(s, j, j + len - 1)); i = j + len
      else put(st, format('\\x%02X', b)); i = j + 1 end
    end
  end
  put(st, '"')
end

-- key order: numbers ascending, then strings, then the other types by
-- type name and, within a type, false before true or by address (%p,
-- which runs no __tostring)
local TORDER = { number = 1, string = 2 }

local function keyless(a, b)
  local ta, tb = type(a), type(b)
  if ta ~= tb then
    local oa, ob = TORDER[ta] or 3, TORDER[tb] or 3
    if oa ~= ob then return oa < ob end
    return ta < tb
  end
  if ta == 'number' or ta == 'string' then return a < b end
  if ta == 'boolean' then return not a and b end
  return format('%p', a) < format('%p', b)
end

-- The K smallest of KEYS (K < #KEYS), sorted.  A max-heap of size K, in
-- Lua (so that it is time-sliced and can be stopped, as table.sort with
-- a Lua comparator cannot be): a table of a million keys shows its first
-- hundred without sorting the million.
local function smallest(keys, k)
  local heap, n = {}, 0
  local function up(i)
    while i > 1 do
      local p = i // 2
      if keyless(heap[p], heap[i]) then heap[p], heap[i] = heap[i], heap[p]; i = p else break end
    end
  end
  local function down(i)
    while true do
      local l, r, m = 2 * i, 2 * i + 1, i
      if l <= n and keyless(heap[m], heap[l]) then m = l end
      if r <= n and keyless(heap[m], heap[r]) then m = r end
      if m == i then return end
      heap[m], heap[i] = heap[i], heap[m]
      i = m
    end
  end
  for _, x in ipairs(keys) do
    if n < k then n = n + 1; heap[n] = x; up(n)
    elseif keyless(x, heap[1]) then heap[1] = x; down(1) end
  end
  sort(heap, keyless)
  return heap
end

local reprvalue

local function reprkey(st, k, depth)
  if type(k) == 'string' and find(k, '^[%a_][%w_]*$') and not RESERVED[k] then
    put(st, k)
  else
    put(st, '[')
    reprvalue(st, k, depth)
    put(st, ']')
  end
  put(st, ' = ')
end

local function reprtable(st, t, depth)
  if st.active[t] then put(st, '<cycle>'); return end
  if depth > st.depth then put(st, '{…}'); return end
  st.active[t] = true
  put(st, '{')
  local count, items = 0, st.items
  local sep = ''
  -- the sequence part: 1, 2, ... up to the first nil
  local seq = 0
  while not st.full do
    local v = rawget(t, seq + 1)
    if v == nil then break end
    seq = seq + 1
    if count >= items then put(st, sep .. '…'); count = -1; break end
    put(st, sep)
    reprvalue(st, v, depth + 1)
    sep = ', '
    count = count + 1
  end
  if count >= 0 and not st.full then
    local keys, nk = {}, 0
    local k = next(t)
    while k ~= nil do
      if not (mathtype(k) == 'integer' and k >= 1 and k <= seq) then nk = nk + 1; keys[nk] = k end
      k = next(t, k)
    end
    local room = items - count
    local more = nk > room
    if more then
      -- (with no room left the sequence part filled the budget)
      keys = room > 0 and smallest(keys, room) or {}
    else sort(keys, keyless) end
    for _, key in ipairs(keys) do
      if st.full then break end
      put(st, sep)
      reprkey(st, key, depth + 1)
      reprvalue(st, rawget(t, key), depth + 1)
      sep = ', '
    end
    if more then put(st, sep .. '…') end
  end
  put(st, '}')
  st.active[t] = nil
end

function reprvalue(st, v, depth)
  if st.full then return end
  local tv = type(v)
  if tv == 'string' then reprstring(st, v)
  elseif tv == 'table' then
    local mt = getmt(v)
    if type(mt) == 'table' and (rawget(mt, '__tostring') ~= nil or rawget(mt, '__name') ~= nil) then
      put(st, tostring(v))
    else
      reprtable(st, v, depth)
    end
  else
    -- numbers ("1" and "1.0" stay apart), nil, booleans, functions,
    -- userdata (a file prints as lauxlib prints it) and threads
    put(st, tostring(v))
  end
end

local DEFAULTS = { depth = 3, items = 100, max = 65536 }

local function repr(v, depth, items, max)
  local st = { n = 0, size = 0, full = false, active = {},
               depth = depth or DEFAULTS.depth, items = items or DEFAULTS.items, max = max or DEFAULTS.max }
  reprvalue(st, v, 1)
  return concat(st, '', 1, st.n)
end

function K.repr(v) return repr(v) end

M.repr = api('repr', function (nargs, v, opts)
  if opts == nil then return repr(v) end
  if type(opts) ~= 'table' then typeerr(2, nargs, opts, 'table') end
  local function opt(name, min)
    local x = rawget(opts, name)
    if x == nil then return DEFAULTS[name] end
    if type(x) ~= 'number' or x ~= x then argerr(2, "field '" .. name .. "' must be a number") end
    if x < min then x = min end
    if x > 1e9 then x = 1e9 end
    return floor(x)
  end
  return repr(v, opt('depth', 0), opt('items', 0), opt('max', 16))
end)


-- ---- markup

local VOID = {}
for _, t in ipairs { 'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr' } do
  VOID[t] = true
end

local ENTITIES = { ['&'] = '&amp;', ['<'] = '&lt;', ['>'] = '&gt;', ['"'] = '&quot;', ["'"] = '&#39;' }

local function escape(s) return (gsub(s, '[&<>"\']', ENTITIES)) end

local function okname(s) return type(s) == 'string' and find(s, '^[A-Za-z][A-Za-z0-9:_.-]*$') ~= nil end

local function quote(s)
  if type(s) == 'string' then return format('%q', s) end
  return typename(s)
end

local MAXDEPTH = 200
local markupnode

-- the text an attribute or a node of a number gets
local function numtext(x) return tostring(x) end

local function element(x, out, svg, depth, seen)
  local tag = rawget(x, 1)
  if not okname(tag) then argerr(1, 'invalid element name ' .. quote(tag)) end
  local n = rawlen(x)
  svg = svg or tag == 'svg'  -- (XML is case-sensitive: "SVG" is not it)
  -- attributes: the string keys, written in sorted order
  local names, nn = {}, 0
  local k = next(x)
  while k ~= nil do
    if type(k) == 'string' then
      if not okname(k) then argerr(1, 'invalid attribute name ' .. quote(k) .. ' in <' .. tag .. '>') end
      nn = nn + 1
      names[nn] = k
    elseif not (mathtype(k) == 'integer' and k >= 1 and k <= n) then
      argerr(1, 'invalid key ' .. (type(k) == 'number' and numtext(k) or typename(k)) .. ' in <' .. tag .. '>')
    end
    k = next(x, k)
  end
  sort(names)
  out[#out + 1] = '<' .. tag
  for i = 1, nn do
    local name = names[i]
    local v = rawget(x, name)
    local tv = type(v)
    if v == true then out[#out + 1] = ' ' .. name .. '=""'
    elseif v == false then -- omitted
    elseif tv == 'string' then out[#out + 1] = ' ' .. name .. '="' .. escape(v) .. '"'
    elseif tv == 'number' then out[#out + 1] = ' ' .. name .. '="' .. escape(numtext(v)) .. '"'
    else argerr(1, 'invalid value for attribute ' .. quote(name) .. ' in <' .. tag .. '> (a ' .. typename(v) .. ')') end
  end
  local void = not svg and VOID[lower(tag)]
  if n < 2 then
    -- HTML: only the void elements close themselves; SVG: every empty one
    out[#out + 1] = (svg or void) and '/>' or '></' .. tag .. '>'
    return
  end
  if void then argerr(1, 'void element <' .. tag .. '> cannot have children') end
  out[#out + 1] = '>'
  for i = 2, n do
    local c = rawget(x, i)
    if c ~= nil then markupnode(c, out, svg, depth + 1, seen) end
  end
  out[#out + 1] = '</' .. tag .. '>'
end

function markupnode(x, out, svg, depth, seen)
  local tx = type(x)
  if tx == 'string' then out[#out + 1] = escape(x); return end
  if tx == 'number' then out[#out + 1] = escape(numtext(x)); return end
  if tx ~= 'table' then argerr(1, 'invalid node (a ' .. typename(x) .. ')') end
  local r = raws[x]
  if r then out[#out + 1] = r; return end
  local d = objs[x]
  if d then
    -- a display object of markup is inserted as it is; others as an
    -- image or as text
    local mime = d[1]
    if mime == 'text/html' or mime == 'image/svg+xml' then out[#out + 1] = d[2]
    elseif find(mime, '^image/') then
      out[#out + 1] = '<img src="data:' .. escape(mime) .. ';base64,' .. escape(d[2]) .. '"/>'
    else out[#out + 1] = escape(d[2]) end
    return
  end
  if seen[x] then argerr(1, 'the element tree has a cycle') end
  if depth > MAXDEPTH then argerr(1, 'the element tree is deeper than ' .. MAXDEPTH .. ' levels') end
  seen[x] = true
  local first = rawget(x, 1)
  if type(first) == 'string' then
    element(x, out, svg, depth, seen)
  elseif first == nil or type(first) == 'table' then
    -- a fragment: its nodes one after the other
    local n = rawlen(x)
    local k = next(x)
    while k ~= nil do
      if not (mathtype(k) == 'integer' and k >= 1 and k <= n) then
        argerr(1, 'invalid key ' .. (type(k) == 'number' and numtext(k) or quote(k)) .. ' in a fragment')
      end
      k = next(x, k)
    end
    for i = 1, n do
      local c = rawget(x, i)
      if c ~= nil then markupnode(c, out, svg, depth + 1, seen) end
    end
  else
    argerr(1, 'invalid element name ' .. quote(first))
  end
  seen[x] = nil
end

local function markup(x)
  local out = {}
  markupnode(x, out, false, 1, {})
  return concat(out)
end

-- a root <svg> without a namespace gets the SVG one (an <img>, an
-- export, or the XML parser of the page's sanitizer need it)
local function svgns(s)
  local _, j = find(s, '^%s*<svg')
  if not j then return s end
  local c = sub(s, j + 1, j + 1)
  if c ~= '' and not find(c, '^[%s>/]') then return s end
  local gt = find(s, '>', j + 1, true) or #s
  if find(sub(s, j + 1, gt), 'xmlns=', 1, true) then return s end
  return sub(s, 1, j) .. ' xmlns="http://www.w3.org/2000/svg"' .. sub(s, j + 1)
end

-- the tree X has a root <svg>
local function svgtree(x)
  if type(x) ~= 'table' or objs[x] or raws[x] then return false end
  local tag = rawget(x, 1)
  return tag == 'svg'
end

-- X (a string, a tree or a raw marker), as markup, for the API function
-- whose argument it is
local function markupof(nargs, x, n)
  if type(x) == 'string' then return x end
  if type(x) ~= 'table' then typeerr(n or 1, nargs, x, 'string or table') end
  return markup(x)
end


-- ---- the module

M.display = api('display', function (nargs, mime, data)
  if type(mime) ~= 'string' then typeerr(1, nargs, mime, 'string') end
  if not find(mime, '^[%w.+-]+/[%w.+-]+$') then argerr(1, 'invalid MIME type ' .. quote(mime)) end
  if type(data) ~= 'string' then typeerr(2, nargs, data, 'string') end
  return mkdisplay(mime, data)
end)

M.isdisplay = function (x) return isdisplay(x) end

M.text = function (x)
  return mkdisplay('text/plain', type(x) == 'string' and x or repr(x))
end

M.html = api('html', function (nargs, x)
  return mkdisplay('text/html', markupof(nargs, x))
end)

M.svg = api('svg', function (nargs, x)
  return mkdisplay('image/svg+xml', svgns(markupof(nargs, x)))
end)

M.markdown = api('markdown', function (nargs, s)
  if type(s) ~= 'string' then typeerr(1, nargs, s, 'string') end
  return mkdisplay('text/markdown', s)
end)

M.markup = api('markup', function (nargs, x)
  if type(x) ~= 'table' then typeerr(1, nargs, x, 'table') end
  return markup(x)
end)

M.raw = api('raw', function (nargs, s)
  if type(s) ~= 'string' then typeerr(1, nargs, s, 'string') end
  local o = setmetatable({}, RAW)
  raws[o] = s
  return o
end)

M.escape = api('escape', function (nargs, s)
  if type(s) == 'number' then return escape(numtext(s)) end
  if type(s) ~= 'string' then typeerr(1, nargs, s, 'string') end
  return escape(s)
end)

-- images: the type is found from the data's first bytes
local IMAGES = { ['image/png'] = true, ['image/jpeg'] = true, ['image/gif'] = true, ['image/webp'] = true }

local function sniff(s)
  if sub(s, 1, 8) == '\137PNG\r\n\26\n' then return 'image/png' end
  if sub(s, 1, 3) == '\255\216\255' then return 'image/jpeg' end
  local g = sub(s, 1, 6)
  if g == 'GIF87a' or g == 'GIF89a' then return 'image/gif' end
  if sub(s, 1, 4) == 'RIFF' and sub(s, 9, 12) == 'WEBP' then return 'image/webp' end
  return nil
end

local NOTIMAGE = 'not a PNG, JPEG, GIF or WebP image'

-- Data that is no image and could be a file name (short, no NUL) is read
-- from that file: notebook.image("plot.png") shows an uploaded file.
M.image = api('image', function (nargs, src, mime)
  if type(src) ~= 'string' then typeerr(1, nargs, src, 'string') end
  if mime ~= nil and not IMAGES[mime] then
    if type(mime) ~= 'string' then typeerr(2, nargs, mime, 'string') end
    argerr(2, 'image/png, image/jpeg, image/gif or image/webp expected, got ' .. quote(mime))
  end
  local data, kind = src, sniff(src)
  if not kind then
    if #src > 0 and #src <= 4096 and not find(src, '\0', 1, true) then
      local f, err = io_open(src, 'rb')
      if not f then argerr(1, err) end
      data = f:read('a')
      f:close()
      kind = sniff(data)
      if not kind and not mime then argerr(1, src .. ' is ' .. NOTIMAGE) end
    elseif not mime then
      argerr(1, NOTIMAGE)
    end
  end
  return mkdisplay(mime or kind, core_base64(data))
end)

-- a record: a table with no [1] that is not a display or raw marker
local function isrecord(r)
  return type(r) == 'table' and rawget(r, 1) == nil and not objs[r] and not raws[r]
end

-- what a table cell holds: markup objects and text as they are, other
-- values as repr shows them
local function cellnode(v)
  if v == nil then return nil end
  local tv = type(v)
  if tv == 'string' or tv == 'number' then return v end
  if tv == 'table' and (objs[v] or raws[v]) then return v end
  return repr(v)
end

M.table = api('table', function (nargs, rows, header)
  if type(rows) ~= 'table' then typeerr(1, nargs, rows, 'table') end
  if header ~= nil and type(header) ~= 'table' then typeerr(2, nargs, header, 'table') end
  local nrows = rawlen(rows)
  local labels, keys
  if header ~= nil then
    labels = {}
    for i = 1, rawlen(header) do labels[i] = rawget(header, i) end
    keys = labels
  else
    -- records without a header: their keys, sorted, are the columns
    local set, ks = {}, {}
    for i = 1, nrows do
      local r = rawget(rows, i)
      if isrecord(r) then
        local k = next(r)
        while k ~= nil do
          if not set[k] then set[k] = true; ks[#ks + 1] = k end
          k = next(r, k)
        end
      end
    end
    if #ks > 0 then
      sort(ks, keyless)
      keys, labels = ks, ks
    end
  end
  local t = { 'table' }
  if labels then
    local tr = { 'tr' }
    for i = 1, #labels do tr[i + 1] = { 'th', cellnode(labels[i]) } end
    t[#t + 1] = { 'thead', tr }
  end
  local body = { 'tbody' }
  for i = 1, nrows do
    local r = rawget(rows, i)
    local tr = { 'tr' }
    if isrecord(r) and keys then
      for j = 1, #keys do tr[j + 1] = { 'td', cellnode(rawget(r, keys[j])) } end
    elseif type(r) == 'table' and not objs[r] and not raws[r] then
      for j = 1, rawlen(r) do tr[j + 1] = { 'td', cellnode(rawget(r, j)) } end
    else
      tr[2] = { 'td', cellnode(r) }
    end
    body[#body + 1] = tr
  end
  t[#t + 1] = body
  return mkdisplay('text/html', markup(t))
end)

-- the display of a value: a display object, or an <svg> tree
local function displayof(v)
  local d = isdisplay(v) and objs[v]
  if d then return d[1], d[2] end
  if svgtree(v) then return 'image/svg+xml', svgns(markup(v)) end
  return nil
end

M.show = api('show', function (nargs, x, id)
  if id ~= nil then
    if type(id) == 'number' then id = numtext(id)
    elseif type(id) ~= 'string' then typeerr(2, nargs, id, 'string') end
  end
  local mime, data = displayof(x)
  if not mime then mime, data = 'text/plain', type(x) == 'string' and x or repr(x) end
  core_display(mime, data, id)
end)

M.clear = function () core_clear() end
M.sleep = core.sleep
M.arch = core.arch
M.version = core.version

-- K.display runs on a cell's results, called from C: a bad tree is
-- reported without a position (there is no Lua caller)
local function displayerr(ok, ...)
  if ok then return ... end
  local e = ...
  if getmt(e) == ARGERR then error('cannot show the value: ' .. e.msg, 0) end
  error(e, 0)
end

function K.display(v)
  if type(v) ~= 'table' then return end
  local mime, data = displayerr(pcall(displayof, v))
  if mime then return mime, data, nil end
end

return M, K

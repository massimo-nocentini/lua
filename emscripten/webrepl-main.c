/*
** $Id: webrepl-main.c $
** Lua console and notebook kernel for the WebAssembly (Emscripten) build
** See Copyright Notice in lua.h
*/

/*
** This is the host side of the web module (lua-repl.js).  It runs the
** unmodified Lua library (liblua.a, every l*.c but lua.c and ltests.c)
** and plays two roles, chosen by the first argument:
**
**   console (default)   a port of lua.c's REPL: banner, "return <line>;"
**                       first, ">>" continuation lines, _PROMPT/_PROMPT2,
**                       the "stdin" chunk name, lua.c's message handler
**                       and error texts, byte for byte;
**   kernel (--notebook) the notebook kernel: it takes requests from a
**                       mailbox and answers with JSON events.
**
** TIME SLICING.  JS (web/repl-driver.js) calls webrepl_resume(), which
** runs one slice of at most about slice_ms (50 ms by default) and
** returns the state (webrepl.h).  Without Asyncify, JSPI or
** SharedArrayBuffer the C stack cannot be kept between two JS calls, so
** every piece of user code runs in a "runner" coroutine of the main
** state G, and a count hook (lw_hook, every LW_HOOKCOUNT instructions)
** makes the runner yield when the slice has expired.  lua_resume then
** returns here, the slice ends, and the next webrepl_resume() resumes
** the runner where it stopped.  G itself never runs user code.
**
** A hook can yield only from the thread being resumed by the host, so
** user coroutines need help: coroutine.resume and coroutine.wrap are
** replaced (from lcorolib) by versions that pass such a "host yield" up
** the chain of resumers, each of them yielding in turn with a
** continuation that resumes the inner thread again.  canfwd(L), in the
** thread's extra space, records whether that chain can reach the runner;
** inside a C call that cannot yield (a sort comparator, a gsub callback,
** require) there is no yield and the slice overruns.  'tostring' and
** 'print' are replaced too, so that the __tostring they call is a
** yieldable call.  The same hook serves to interrupt (Stop): with 'intr'
** set it raises "interrupted!", as lua.c's SIGINT hook does.  Code inside
** a C call that cannot yield and never returns is stopped by the page's
** watchdog only.
**
** INPUT.  stdin is musl's buffered 'stdin'; its fd-0 stream op takes the
** bytes JS fed (webrepl_feed) from a queue.  io.read, io.lines and the
** read/lines methods of FILE* are wrapped: on 'stdin', when the bytes the
** read needs are not there yet, they yield (state WAITING) and run the
** original liolib function once they are.  The REPL takes its lines
** from the same 'stdin', so nothing fed is ever skipped or reordered.
** The kernel drops what a cell left unread when the cell ends.
**
** OUTPUT.  The stream ops of fds 1 and 2 are replaced (lw_js_stdio) by
** ones that pass each write to Module.onLuaOutput(fd, bytes).  stdout is
** line buffered and stderr unbuffered, as on a tty.  Two more pseudo-fds
** reach the same callback: 4 carries the REPL's prompts, 3 the kernel's
** events, one JSON object per line.  stdout is flushed before each write
** to any of the others, so the order in which Lua wrote is kept.
**
** KERNEL PROTOCOL (webrepl_post, one whole request each, FIFO):
**   "run RID NAME\nSOURCE"  evaluate a cell: events start, display,
**                           clear and done
**   "ping RID"              answered by pong
**   anything else           answered by bad-request
** The events and their fields are listed in emscripten/README.md.
** Cells see the module notebook.lua (embedded at /lua-web/notebook.lua),
** which formats their values (K.repr) and builds rich output (K.display)
** over the C primitives of 'core' below.
**
** EXIT.  os.exit, EOF at the first-line prompt and a failed startup job
** end in exit(), whose proc_exit throws an ExitStatus out of
** webrepl_resume; the driver catches it.  Every entry point then returns
** at once.
**
** All glue work on G that can allocate or raise runs in protected mode
** (lw_protect), so running out of memory gives "not enough memory",
** never a panic.  Kernel events are serialised in C into malloc'd
** buffers.
*/

#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdio_ext.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

#include <emscripten.h>

#include "lua.h"

#include "lauxlib.h"
#include "lualib.h"

#include "webrepl.h"


#define LW_PROGNAME	"lua"
#define LW_INIT_VAR	"LUA_INIT"
#define LW_HOOKCOUNT	1000		/* instructions between two hook calls */
#define LW_NBFILE	"/lua-web/notebook.lua"

/* registry fields of the glue */
#define KEY_ERRTEXT	"lua-web.errtext"	/* kernel: message without traceback */
#define KEY_PENDING	"lua-web.pending"	/* REPL: incomplete statement so far */
#define KEY_REPR	"lua-web.repr"		/* notebook.lua's K.repr */
#define KEY_DISPLAY	"lua-web.display"	/* notebook.lua's K.display */
#define KEY_IOOUTPUT	"lua-web.io.output"	/* kernel: the original io.output */
#define KEY_IOINPUT	"lua-web.io.input"
#define KEY_STDOUT	"lua-web.io.stdout"
#define KEY_STDIN	"lua-web.io.stdin"
#define KEY_SETHOOK	"lua-web.sethook"	/* the original debug.sethook */
#define KEY_GETHOOK	"lua-web.gethook"	/* the original debug.gethook */
#define KEY_HOOK	"lua-web.hook"		/* {f, mask, count}: the user hook kept */

/* kernel event caps: every event length fits an int */
#define DISPLAY_CAP	4194304		/* display data over this is not sent */
#define TEXT_CAP	65536		/* ErrorObj text and traceback */
#define CHAIN_MAX	50

#define MODE_REPL	0
#define MODE_KERNEL	1

/* why the runner yielded to the host */
#define HY_NONE		0
#define HY_SLICE	1
#define HY_INPUT	2
#define HY_SLEEP	3

/* the kind of work the runner does */
#define WK_JOB		0	/* a startup job: init, -e, -l, script */
#define WK_LINE		1	/* a REPL chunk */
#define WK_CELL		2	/* a notebook cell */

#define CANNOT_WAIT	"(inside a C call such as a sort comparator, gsub callback, __tostring or require)"


static lua_State *G = NULL;	/* the main thread: never runs user code */
static lua_State *runner = NULL;	/* the current chunk's coroutine */
static int runner_ref = LUA_NOREF;	/* anchors it in the registry */
static int rnargs;		/* arguments of the runner's first resume */
static int work;		/* WK_* of the runner */

static int mode = MODE_REPL;
static int state = WEBREPL_RUNNING, prompt, started, exited, exit_code;
static int intr, cell_intr, in_slice, hy = HY_NONE;
static double slice_ms = 50, slice_t0, slice_end, wake_at, run_ms;
static size_t out_slice;

/* the stdin queue: bytes fed by JS, read only through musl's 'stdin' */
static char *in_buf;
static size_t in_len, in_pos, in_cap;
static int in_eof, in_new;	/* in_new: something was fed since the slice began */

/* the notebook kernel's mailbox (as chicken's) */
struct req { struct req *next; int len; char data[]; };
static struct req *req_head, *req_tail;

/* the REPL */
static int ml_pending;		/* an incomplete statement waits for '>>' lines */
static char *lbuf;		/* getline's buffer */
static size_t lcap;

/* the cell being evaluated (kernel); rid 0 outside a cell */
static long cell_rid;
static char cell_name[40];
static double cell_ms0;
static int cell_nres;

/* a growing byte buffer, for kernel events */
typedef struct JBuf { char *p; size_t n, cap; int oom; } JBuf;
static JBuf done_jb;		/* the pending 'done' of the current cell */
static JBuf init_jb;		/* the 'init' event, once the init job ended */


/*
** {==================================================================
** Time, JS glue and output
** ===================================================================
*/

static double lw_now (void) { return emscripten_get_now(); }

/* milliseconds spent inside slices so far (os.clock, cell times) */
static double lw_run_ms (void) {
  return run_ms + (in_slice ? lw_now() - slice_t0 : 0);
}


/*
** Replaces the stream ops of fds 0, 1 and 2.  A write to stderr first
** flushes C's stdout (webrepl_flush_stdout), so that the two keep the
** order in which Lua wrote them, as one terminal would show them with an
** unbuffered stdout.  The writes go to
** Module.onLuaOutput in pieces of at most 1 MiB, copied first (the
** callback may grow the memory, which detaches the heap views); the
** driver's streaming TextDecoders join pieces split inside a UTF-8
** sequence.  Reads take queued bytes through webrepl_stdin_read, which
** returns -1 when there are none yet: musl then sees EAGAIN, but the
** read wrappers below call liolib only once the bytes a read needs are
** there.  The TTY ioctl is kept, so musl still sees a tty.  No JS
** exception may unwind through Lua frames, hence the try/catch.
*/
EM_JS(void, lw_js_stdio, (void), {
  var PIECE = 1 << 20;
  function output(fd) {
    var s = FS.getStream(fd);
    if (!s) return;
    var ops = Object.assign({}, s.stream_ops);
    ops.write = function (stream, buffer, offset, length, position) {
      try {
        if (fd === 2) Module['_webrepl_flush_stdout']();
        Module['_webrepl_note_output'](length);
        var all = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice();
        var f = Module['onLuaOutput'];
        if (f) {
          if (length <= PIECE) f(fd, all);
          else for (var i = 0; i < length; i += PIECE)
            f(fd, all.subarray(i, Math.min(length, i + PIECE)));
        }
      } catch (e) { console.error(e); }
      return length;
    };
    ops.fsync = function () { return 0; };
    ops.close = function () {};
    s.stream_ops = ops;
  }
  output(1);
  output(2);
  var s0 = FS.getStream(0);
  if (s0) {
    var ops0 = Object.assign({}, s0.stream_ops);
    ops0.read = function (stream, buffer, offset, length, position) {
      var n = -1;
      try {
        if (buffer.buffer === HEAPU8.buffer)
          n = Module['_webrepl_stdin_read'](buffer.byteOffset + offset, length);
        else {
          var p = Module['_malloc'](Math.max(1, length));
          if (p) {
            n = Module['_webrepl_stdin_read'](p, length);
            if (n > 0) buffer.set(HEAPU8.subarray(p, p + n), offset);
            Module['_free'](p);
          }
        }
      } catch (e) { console.error(e); n = -1; }
      if (n < 0) throw new FS.ErrnoError(6);   /* EAGAIN */
      return n;
    };
    ops0.close = function () {};
    s0.stream_ops = ops0;
  }
});

/* fds 3 (kernel events) and 4 (prompts).  On wasm64 P is a BigInt. */
EM_JS(void, lw_emit_js, (int fd, const char *p, int n), {
  try {
    p = Number(p);
    var f = Module['onLuaOutput'];
    if (f) f(fd, HEAPU8.slice(p, p + n));
  } catch (e) { console.error(e); }
});

static void lw_emit (int fd, const char *p, size_t n) {
  fflush(stdout);  /* keep the order with stdout */
  lw_emit_js(fd, p, n > INT_MAX ? INT_MAX : (int)n);
}

/* lua.c's 'l_message' and 'report', with stdout flushed first */
static void lw_message (const char *pname, const char *msg) {
  fflush(stdout);
  if (pname) fprintf(stderr, "%s: ", pname);
  fprintf(stderr, "%s\n", msg);
  fflush(stderr);
}

/* the error object on top of L as a message, without allocating */
static const char *lw_errmsg (lua_State *L, size_t *len) {
  if (lua_type(L, -1) == LUA_TSTRING) return lua_tolstring(L, -1, len);
  *len = sizeof("(error message not a string)") - 1;
  return "(error message not a string)";
}

/* }================================================================== */


/*
** {==================================================================
** The stdin queue
** ===================================================================
*/

static void lw_drop_input (void) {
  free(in_buf);
  in_buf = NULL;
  in_len = in_pos = in_cap = 0;
  in_eof = 0;
  __fpurge(stdin);
  clearerr(stdin);
}


/*
** The bytes a read would see: those musl has buffered (A, which
** includes the ungetc area) and then the unread queue (B).
*/
typedef struct Avail { const char *a; size_t na; const char *b; size_t nb; } Avail;

static void lw_avail (Avail *v) {
  v->na = 0;
  v->a = __freadptr(stdin, &v->na);
  if (v->a == NULL) v->na = 0;
  v->b = in_buf ? in_buf + in_pos : NULL;
  v->nb = in_len - in_pos;
}

static int lw_byte (const Avail *v, size_t i) {
  return (unsigned char)(i < v->na ? v->a[i] : v->b[i - v->na]);
}

/* position of the first '\n' at or after FROM, or (size_t)-1 */
static size_t lw_findnl (const Avail *v, size_t from) {
  const char *q;
  if (from < v->na) {
    q = memchr(v->a + from, '\n', v->na - from);
    if (q) return (size_t)(q - v->a);
    from = v->na;
  }
  if (from - v->na < v->nb) {
    q = memchr(v->b + (from - v->na), '\n', v->nb - (from - v->na));
    if (q) return v->na + (size_t)(q - v->b);
  }
  return (size_t)-1;
}


/*
** Whether the read formats at stack indices FIRST..LAST (none: "l")
** would find what they need: a simulation, in sequence over the same
** bytes, of liolib's 'g_read'.  A malformed format counts as ready, so
** that liolib raises its own error.
*/
static int lw_ready (lua_State *L, int first, int last) {
  Avail v;
  size_t total, pos = 0;
  int i;
  if (in_eof) return 1;
  lw_avail(&v);
  total = v.na + v.nb;
  if (first > last)
    return lw_findnl(&v, 0) != (size_t)-1;
  for (i = first; i <= last; i++) {
    if (lua_type(L, i) == LUA_TNUMBER) {
      int isnum;
      lua_Integer k = lua_tointegerx(L, i, &isnum);
      if (!isnum) return 1;
      if (k < 0) return 0;  /* liolib reads it as a huge size_t: up to EOF */
      /* io.read(0) tests for EOF: it needs one byte, or the EOF */
      if ((lua_Unsigned)(k == 0 ? 1 : k) > (lua_Unsigned)(total - pos))
        return 0;
      pos += (size_t)k;
    }
    else if (lua_type(L, i) == LUA_TSTRING) {
      const char *p = lua_tostring(L, i);
      size_t nl;
      if (*p == '*') p++;
      switch (*p) {
        case 'n':  /* the leading spaces, then the token up to a space */
          while (pos < total && isspace(lw_byte(&v, pos))) pos++;
          while (pos < total && !isspace(lw_byte(&v, pos))) pos++;
          /* the numeral stops at that space at the latest: it is the one
             byte of lookahead that read_number puts back, and the next
             format starts at it, as liolib's does */
          if (pos >= total) return 0;
          break;
        case 'l': case 'L':
          if ((nl = lw_findnl(&v, pos)) == (size_t)-1) return 0;
          pos = nl + 1;
          break;
        case 'a':
          return 0;  /* EOF only (checked above) */
        default:
          return 1;
      }
    }
    else return 1;
  }
  return 1;
}


/* a REPL line: a '\n', or the last bytes before an EOF */
static int lw_line_ready (void) {
  Avail v;
  lw_avail(&v);
  if (lw_findnl(&v, 0) != (size_t)-1) return 1;
  return in_eof && v.na + v.nb > 0;
}

/* }================================================================== */


/*
** {==================================================================
** Kernel events (JSON, one object per line on fd 3)
** ===================================================================
*/

static void jb_add (JBuf *b, const char *s, size_t len) {
  if (b->oom) return;
  if (b->cap - b->n < len + 1) {
    size_t ncap = b->cap ? b->cap : 256;
    char *np;
    while (ncap - b->n < len + 1) {
      if (ncap > ((size_t)-1) / 2) { b->oom = 1; return; }
      ncap *= 2;
    }
    if ((np = realloc(b->p, ncap)) == NULL) { b->oom = 1; return; }
    b->p = np;
    b->cap = ncap;
  }
  memcpy(b->p + b->n, s, len);
  b->n += len;
}

static void jb_lit (JBuf *b, const char *s) { jb_add(b, s, strlen(s)); }

static void jb_fmt (JBuf *b, const char *fmt, ...) {
  char tmp[160];
  int n;
  va_list ap;
  va_start(ap, fmt);
  n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
  va_end(ap);
  if (n > 0) jb_add(b, tmp, (size_t)n < sizeof(tmp) ? (size_t)n : sizeof(tmp) - 1);
}

static void jb_free (JBuf *b) {
  free(b->p);
  b->p = NULL;
  b->n = b->cap = 0;
  b->oom = 0;
}

/* the bytes as a JSON string: '"', '\' and controls escaped, the rest raw */
static void jb_strbody (JBuf *b, const char *s, size_t len) {
  size_t i, run = 0;
  for (i = 0; i < len; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c >= 0x20 && c != '"' && c != '\\') continue;
    jb_add(b, s + run, i - run);
    run = i + 1;
    switch (c) {
      case '"': jb_add(b, "\\\"", 2); break;
      case '\\': jb_add(b, "\\\\", 2); break;
      case '\n': jb_add(b, "\\n", 2); break;
      case '\t': jb_add(b, "\\t", 2); break;
      case '\r': jb_add(b, "\\r", 2); break;
      default: jb_fmt(b, "\\u%04x", c); break;
    }
  }
  jb_add(b, s + run, len - run);
}

static void jb_str (JBuf *b, const char *s, size_t len) {
  jb_add(b, "\"", 1);
  jb_strbody(b, s, len);
  jb_add(b, "\"", 1);
}

/* a string cut to CAP bytes (at a character start), then an ellipsis */
static void jb_strcap (JBuf *b, const char *s, size_t len) {
  if (len <= TEXT_CAP) { jb_str(b, s, len); return; }
  len = TEXT_CAP;
  while (len > 0 && ((unsigned char)s[len] & 0xc0) == 0x80) len--;
  jb_add(b, "\"", 1);
  jb_strbody(b, s, len);
  jb_lit(b, "\xe2\x80\xa6\"");
}

/* a traceback cut at a line end before CAP bytes, then "\n\t..." */
static void jb_tbcap (JBuf *b, const char *s, size_t len) {
  size_t cut;
  if (len <= TEXT_CAP) { jb_str(b, s, len); return; }
  for (cut = TEXT_CAP; cut > 0 && s[cut] != '\n'; cut--) ;
  if (cut == 0) {
    cut = TEXT_CAP;
    while (cut > 0 && ((unsigned char)s[cut] & 0xc0) == 0x80) cut--;
  }
  jb_add(b, "\"", 1);
  jb_strbody(b, s, cut);
  jb_lit(b, "\\n\\t\xe2\x80\xa6\"");
}


/* L when TEXT starts with "NAME:L:", else 0 */
static long lw_errline (const char *text, size_t tlen, const char *name) {
  size_t nl = name ? strlen(name) : 0;
  size_t i;
  long line = 0;
  if (nl == 0 || tlen <= nl + 2 || memcmp(text, name, nl) != 0 || text[nl] != ':')
    return 0;
  for (i = nl + 1; i < tlen && isdigit((unsigned char)text[i]); i++) {
    if (line > 100000000L) return 0;
    line = line * 10 + (text[i] - '0');
  }
  return (i > nl + 1 && i < tlen && text[i] == ':') ? line : 0;
}


/*
** The frames of a traceback ("\t<where>: in <proc>" lines after
** "stack traceback:"), innermost first.  The last one, the glue's
** lw_body ("[C]: in ?"), is dropped.
*/
static void jb_chain (JBuf *b, const char *tb, size_t tblen, size_t tlen) {
  static const char head[] = "stack traceback:";
  size_t hl = sizeof(head) - 1;
  size_t pos = (size_t)-1, i;
  int count = 0, first = 1;
  /* the section starts right after the message, when the traceback
     begins with it; otherwise at the last header */
  if (tlen + 1 + hl <= tblen && tb[tlen] == '\n' && memcmp(tb + tlen + 1, head, hl) == 0)
    pos = tlen + 1 + hl;
  else {
    for (i = 0; i + hl <= tblen; i++)
      if ((i == 0 || tb[i - 1] == '\n') && memcmp(tb + i, head, hl) == 0)
        pos = i + hl;
  }
  if (pos == (size_t)-1) return;
  while (pos < tblen && tb[pos] == '\n' && pos + 1 < tblen && tb[pos + 1] == '\t') {
    const char *line = tb + pos + 2, *end, *sep;
    size_t len;
    end = memchr(line, '\n', tblen - (pos + 2));
    len = end ? (size_t)(end - line) : tblen - (pos + 2);
    pos += 2 + len;
    if (pos >= tblen && len == sizeof("[C]: in ?") - 1 &&
        memcmp(line, "[C]: in ?", len) == 0)
      break;  /* the glue's own frame */
    if (count >= CHAIN_MAX) break;
    if (!first) jb_add(b, ",", 1);
    first = 0;
    count++;
    if (len >= 4 && memcmp(line, "...\t", 4) == 0) {
      jb_lit(b, "{\"where\":\"\",\"proc\":");
      jb_str(b, line + 4, len - 4);
    }
    else if (line[0] == '(') {
      jb_lit(b, "{\"where\":\"\",\"proc\":");
      jb_str(b, line, len);
    }
    else {
      size_t k;
      sep = NULL;
      for (k = 0; k + 5 <= len; k++)
        if (memcmp(line + k, ": in ", 5) == 0) { sep = line + k; break; }
      jb_lit(b, "{\"where\":");
      if (sep) {
        jb_str(b, line, (size_t)(sep - line));
        jb_lit(b, ",\"proc\":");
        jb_str(b, sep + 5, len - (size_t)(sep - line) - 5);
      }
      else {
        jb_str(b, line, len);
        jb_lit(b, ",\"proc\":\"\"");
      }
    }
    jb_add(b, "}", 1);
  }
}


/* an ErrorObj (see emscripten/README.md) */
static void jb_errobj (JBuf *b, const char *kind, const char *text, size_t tlen,
                       const char *tb, size_t tblen, int chain, int form,
                       const char *name) {
  long line = lw_errline(text, tlen, name);
  jb_lit(b, "{\"text\":");
  jb_strcap(b, text, tlen);
  jb_fmt(b, ",\"kind\":[\"%s\"],\"line\":", kind);
  if (line > 0) jb_fmt(b, "%ld", line); else jb_lit(b, "null");
  jb_lit(b, ",\"chain\":[");
  if (chain) jb_chain(b, tb, tblen, tlen);
  jb_lit(b, form ? "],\"form\":\"print\"" : "],\"form\":null");
  jb_lit(b, ",\"traceback\":");
  jb_tbcap(b, tb, tblen);
  jb_lit(b, "}");
}

static const char *lw_kind (int status) {
  switch (status) {
    case LUA_ERRSYNTAX: return "syntax";
    case LUA_ERRMEM: return "memory";
    case LUA_ERRERR: return "error-handler";
    default: return "runtime";
  }
}


/*
** The ErrorObj of a runner's error (its value on top of L, the message
** handler's result for LUA_ERRRUN), with the message the handler kept
** in KEY_ERRTEXT.  KIND overrides the status's kind when not NULL.
*/
static void jb_runerror (JBuf *b, lua_State *L, int status, const char *kind,
                         const char *name) {
  size_t tblen, tlen;
  const char *tb = lw_errmsg(L, &tblen);
  const char *text = NULL;
  int chain = 0;
  if (kind == NULL) kind = lw_kind(status);
  lua_getfield(L, LUA_REGISTRYINDEX, KEY_ERRTEXT);
  if (status == LUA_ERRMEM) {
    tb = text = "not enough memory";
    tblen = tlen = strlen(text);
  }
  else if (status == LUA_ERRRUN && lua_type(L, -1) == LUA_TSTRING) {
    text = lua_tolstring(L, -1, &tlen);
    chain = 1;
  }
  else {
    text = tb;
    tlen = tblen;
  }
  jb_errobj(b, kind, text, tlen, tb, tblen, chain, 0, name);
  lua_pop(L, 1);
}

static void lw_clear_errtext (lua_State *L) {
  lua_pushboolean(L, 0);
  lua_setfield(L, LUA_REGISTRYINDEX, KEY_ERRTEXT);
}


/* the fixed 'done' for a memory error: no allocation at all */
static void lw_emit_memdone (void) {
  char tmp[400];
  int n = snprintf(tmp, sizeof(tmp),
    "{\"ev\":\"done\",\"rid\":%ld,\"ms\":%.1f,\"status\":\"error\",\"values\":null,"
    "\"error\":{\"text\":\"not enough memory\",\"kind\":[\"memory\"],\"line\":null,"
    "\"chain\":[],\"form\":null,\"traceback\":\"not enough memory\"}}\n",
    cell_rid, lw_run_ms() - cell_ms0);
  lw_emit(3, tmp, (size_t)n);
}

/* sends an event and frees its buffer; a DONE event has a fallback */
static void lw_event (JBuf *b, int done) {
  jb_add(b, "\n", 1);
  if (b->oom) {
    if (done) lw_emit_memdone();
    else lw_message(NULL, "not enough memory");
  }
  else lw_emit(3, b->p, b->n);
  jb_free(b);
}

static void lw_event_lit (const char *s) {
  JBuf b = {NULL, 0, 0, 0};
  jb_lit(&b, s);
  lw_event(&b, 0);
}

/* the start of the cell's 'done' (in done_jb), up to "values": */
static void lw_done_begin (const char *status) {
  jb_free(&done_jb);
  jb_fmt(&done_jb, "{\"ev\":\"done\",\"rid\":%ld,\"ms\":%.1f,\"status\":\"%s\",\"values\":",
         cell_rid, lw_run_ms() - cell_ms0, status);
}

/* a 'done' with no values and this error */
static void lw_done_error (const char *status, const char *kind, const char *text,
                           size_t tlen, const char *tb, size_t tblen, int form) {
  lw_done_begin(status);
  jb_lit(&done_jb, "null,\"error\":");
  jb_errobj(&done_jb, kind, text, tlen, tb, tblen, 0, form, cell_name);
  jb_lit(&done_jb, "}");
}

static void lw_emit_done (void) {
  if (done_jb.p == NULL && !done_jb.oom)  /* no result was recorded */
    lw_done_error("error", "runtime", "(no result)", 11, "(no result)", 11, 0);
  lw_event(&done_jb, 1);
}


/* a display (core.display, or a cell value that K.display recognised) */
static void lw_display (const char *mime, size_t mlen, const char *data, size_t dlen,
                        const char *id, size_t idlen) {
  JBuf b = {NULL, 0, 0, 0};
  jb_fmt(&b, "{\"ev\":\"display\",\"rid\":%ld,\"mime\":", cell_rid);
  jb_str(&b, mime, mlen);
  jb_lit(&b, ",\"data\":");
  if (dlen > DISPLAY_CAP) jb_lit(&b, "\"\""); else jb_str(&b, data, dlen);
  jb_lit(&b, ",\"id\":");
  if (id) jb_str(&b, id, idlen); else jb_lit(&b, "null");
  if (dlen > DISPLAY_CAP) jb_fmt(&b, ",\"size\":%zu", dlen);
  jb_lit(&b, "}");
  lw_event(&b, 0);
}

/* }================================================================== */


/*
** {==================================================================
** Protection of glue work on G
** ===================================================================
*/

/*
** Pushing a light C function and a light userdata never allocates, and
** G always has LUA_MINSTACK free slots here (the glue leaves its stack
** empty between calls), so nothing can fail outside the protected call.
*/
static int lw_protect (lua_CFunction f, void *ud) {
  lua_pushcfunction(G, f);
  lua_pushlightuserdata(G, ud);
  return lua_pcall(G, 1, 0, 0);
}

/* the unit of work that STATUS (from lw_protect) ended is reported failed */
static void lw_glue_fail (int status) {
  size_t len;
  const char *msg = lw_errmsg(G, &len);
  if (status == LUA_ERRMEM) { msg = "not enough memory"; len = strlen(msg); }
  if (mode == MODE_KERNEL && cell_rid != 0) {
    lw_done_error("error", lw_kind(status), msg, len, msg, len, 0);
    if (done_jb.oom) jb_free(&done_jb);  /* lw_emit_done falls back */
  }
  else lw_message(NULL, msg);
  lua_settop(G, 0);
}


static int lw_panic (lua_State *L) {
  const char *msg = (lua_type(L, -1) == LUA_TSTRING) ? lua_tostring(L, -1)
                                                    : "error object is not a string";
  fflush(stdout);
  fprintf(stderr, "PANIC: unprotected error in call to Lua API (%s)\n", msg);
  fflush(stderr);
  abort();
  return 0;
}

/* }================================================================== */


/*
** {==================================================================
** Hook, host yields and exit
** ===================================================================
*/

/* per-thread: may a host yield travel from this thread up to the runner? */
#define canfwd(L)	(*(int *)lua_getextraspace(L))

static int lw_hostyieldable (lua_State *L) {
  return lua_isyieldable(L) && (L == runner || canfwd(L));
}


/*
** The glue's count hook.  Only count events are armed (a yield from a
** call hook would lose the chunk's results), and a Stop arms count 1, so
** that a 'pcall' catching "interrupted!" cannot resume a loop.  As in
** lua.c's 'lstop', luaL_error uses level 1: the caller of the function
** that was running, so a loop at the top of a chunk (called by the C
** body) gives a message without position.
*/
static void lw_hook (lua_State *L, lua_Debug *ar) {
  if (ar->event != LUA_HOOKCOUNT) return;
  if (intr) {
    if (lua_gethookcount(L) != 1) lua_sethook(L, lw_hook, LUA_MASKCOUNT, 1);
    luaL_error(L, "interrupted!");
  }
  if (lua_gethookcount(L) == 1)  /* armed for an earlier Stop */
    lua_sethook(L, lw_hook, LUA_MASKCOUNT, LW_HOOKCOUNT);
  if (lw_now() >= slice_end && lw_hostyieldable(L)) {
    hy = HY_SLICE;
    lua_yield(L, 0);
  }
}

static void lw_arm (lua_State *L) {
  if (intr && lua_gethook(L) == lw_hook) lua_sethook(L, lw_hook, LUA_MASKCOUNT, 1);
}


/*
** Exit: as lua.c returning from 'main' (CLOSE: lua_close first, so
** pending finalizers run) or os.exit.  From os.exit(c, true) this runs
** inside the runner, with its frames still on the C stack, exactly as
** loslib's os_exit calls lua_close: nothing returns to them, because
** exit() throws (proc_exit's ExitStatus) out of webrepl_resume.
*/
static void lw_exit (int code, int close) {
  fflush(stdout);
  fflush(stderr);
  if (close && G != NULL) {
    lua_State *L = G;
    G = runner = NULL;
    lua_close(L);
    fflush(stdout);
    fflush(stderr);
  }
  exited = 1;
  exit_code = code;
  state = WEBREPL_EXITED;
  exit(code);
}

/* }================================================================== */


/*
** {==================================================================
** Replacements in the Lua tables
** ===================================================================
*/

/*
** coroutine.resume and coroutine.wrap that forward host yields, adapted
** from lcorolib.c's 'auxresume', 'luaB_coresume' and 'luaB_auxwrap'.
** Returns the number of results, -1 for an error (message on L), or -2
** when CO made a host yield, which L must pass on.  CO's state is
** checked first, as lua_resume would (its texts), so that canfwd(co) is
** never changed for a thread that cannot be resumed (such as one that
** is running).
*/
static int lw_auxresume (lua_State *L, lua_State *co, int narg) {
  int status, nres;
  lua_Debug ar;
  if (lua_status(co) == LUA_OK) {
    if (lua_getstack(co, 0, &ar)) {
      lua_pushliteral(L, "cannot resume non-suspended coroutine");
      return -1;
    }
    else if (lua_gettop(co) == 0) {
      lua_pushliteral(L, "cannot resume dead coroutine");
      return -1;
    }
  }
  else if (lua_status(co) != LUA_YIELD) {
    lua_pushliteral(L, "cannot resume dead coroutine");
    return -1;
  }
  if (!lua_checkstack(co, narg)) {
    lua_pushliteral(L, "too many arguments to resume");
    return -1;
  }
  lua_xmove(L, co, narg);
  canfwd(co) = lw_hostyieldable(L);
  lw_arm(co);
  status = lua_resume(co, L, narg, &nres);
  if (status == LUA_YIELD && hy != HY_NONE) {  /* a host yield */
    lua_pop(co, nres);
    return -2;
  }
  if (status == LUA_OK || status == LUA_YIELD) {
    if (!lua_checkstack(L, nres + 1)) {
      lua_pop(co, nres);  /* remove results anyway */
      lua_pushliteral(L, "too many results to resume");
      return -1;
    }
    lua_xmove(co, L, nres);  /* move yielded values */
    return nres;
  }
  else {
    lua_xmove(co, L, 1);  /* move error message */
    return -1;
  }
}

static int lw_coresumek (lua_State *L, int status, lua_KContext ctx);

static int lw_resumeret (lua_State *L, int r) {
  if (r == -2)  /* pass the host yield on; the thread stays at index 1 */
    return lua_yieldk(L, 0, 0, lw_coresumek);
  if (r < 0) {
    lua_pushboolean(L, 0);
    lua_insert(L, -2);
    return 2;  /* return false + error message */
  }
  lua_pushboolean(L, 1);
  lua_insert(L, -(r + 1));
  return r + 1;  /* return true + 'resume' returns */
}

static int lw_coresumek (lua_State *L, int status, lua_KContext ctx) {
  (void)status; (void)ctx;
  return lw_resumeret(L, lw_auxresume(L, lua_tothread(L, 1), 0));
}

static int lw_coresume (lua_State *L) {
  lua_State *co = lua_tothread(L, 1);
  luaL_argexpected(L, co, 1, "thread");
  return lw_resumeret(L, lw_auxresume(L, co, lua_gettop(L) - 1));
}


static int lw_auxwrapk (lua_State *L, int status, lua_KContext ctx);

static int lw_wrapret (lua_State *L, lua_State *co, int r) {
  if (r == -2)
    return lua_yieldk(L, 0, 0, lw_auxwrapk);
  if (r < 0) {  /* error?  (as lcorolib's 'luaB_auxwrap') */
    int stat = lua_status(co);
    if (stat != LUA_OK && stat != LUA_YIELD) {  /* error in the coroutine? */
      stat = lua_closethread(co, L);  /* close its tbc variables */
      if (stat == LUA_OK)
        return 0;  /* nothing to return */
      lua_xmove(co, L, 1);  /* move error message to the caller */
    }
    if (stat != LUA_ERRMEM &&  /* not a memory error and ... */
        lua_type(L, -1) == LUA_TSTRING) {  /* ... error object is a string? */
      luaL_where(L, 1);  /* add extra info, if available */
      lua_insert(L, -2);
      lua_concat(L, 2);
    }
    return lua_error(L);  /* propagate error */
  }
  return r;
}

static int lw_auxwrapk (lua_State *L, int status, lua_KContext ctx) {
  lua_State *co = lua_tothread(L, lua_upvalueindex(1));
  (void)status; (void)ctx;
  return lw_wrapret(L, co, lw_auxresume(L, co, 0));
}

static int lw_auxwrap (lua_State *L) {
  lua_State *co = lua_tothread(L, lua_upvalueindex(1));
  return lw_wrapret(L, co, lw_auxresume(L, co, lua_gettop(L)));
}

static int lw_cowrap (lua_State *L) {
  lua_State *NL;
  luaL_checktype(L, 1, LUA_TFUNCTION);
  NL = lua_newthread(L);
  lua_pushvalue(L, 1);  /* move function to top */
  lua_xmove(L, NL, 1);  /* move function from L to NL */
  lua_pushcclosure(L, lw_auxwrap, 1);
  return 1;
}


/*
** The runner is the chunk's "main thread": yielding from it would end
** the chunk, so it is an error with lua.c's text (no position, as
** luaG_runerror from a C frame gives none).
*/
static int lw_coyield (lua_State *L) {
  if (L == runner) {
    lua_pushliteral(L, "attempt to yield from outside a coroutine");
    return lua_error(L);
  }
  return lua_yield(L, lua_gettop(L));
}

static int lw_corunning (lua_State *L) {
  int ismain = lua_pushthread(L);
  lua_pushboolean(L, ismain || L == runner);
  return 2;
}

static int lw_coisyieldable (lua_State *L) {
  lua_State *co = L;
  if (!lua_isnone(L, 1)) {
    co = lua_tothread(L, 1);
    luaL_argexpected(L, co, 1, "thread");
  }
  lua_pushboolean(L, co != runner && lua_isyieldable(co));
  return 1;
}


/*
** Yieldable reads of 'stdin'.  The wrappers keep the original liolib
** function as upvalue 1 and call it, unchanged, once lw_ready says the
** bytes it needs are there, so liolib's parsing is reused exactly.  The
** continuation context packs: bit 0 "the original was called", bit 1
** "call it without arguments" (a lines iterator, whose formats are its
** own upvalues), bits 2-3 the index of the first format minus 1, and
** the number of values the read started with above.
*/
#define RD_CALLED	1
#define RD_NOARGS	2
#define RD_CTX(n, first, noargs) \
  (((lua_KContext)(n) << 4) | ((lua_KContext)((first) - 1) << 2) | ((noargs) ? RD_NOARGS : 0))

static int lw_isstdin (lua_State *L, int idx) {
  luaL_Stream *p = (luaL_Stream *)luaL_testudata(L, idx, LUA_FILEHANDLE);
  return p != NULL && p->closef != NULL && p->f == stdin;
}

static int lw_readk (lua_State *L, int status, lua_KContext ctx) {
  int n = (int)(ctx >> 4);
  int first = (int)((ctx >> 2) & 3) + 1;
  (void)status;
  if (ctx & RD_CALLED) {  /* the original returned */
    if (feof(stdin)) {  /* this read took the EOF: it ends this read only */
      in_eof = 0;
      clearerr(stdin);
    }
    return lua_gettop(L) - n;
  }
  if (intr)
    return luaL_error(L, "interrupted!");
  fflush(stdout);  /* a prompt written with io.write appears */
  clearerr(stdin);
  if (lw_ready(L, first, n)) {
    int i, nargs = (ctx & RD_NOARGS) ? 0 : n;
    lua_pushvalue(L, lua_upvalueindex(1));
    for (i = 1; i <= nargs; i++) lua_pushvalue(L, i);
    lua_callk(L, nargs, LUA_MULTRET, ctx | RD_CALLED, lw_readk);
    return lw_readk(L, LUA_OK, ctx | RD_CALLED);
  }
  if (lw_hostyieldable(L)) {
    hy = HY_INPUT;
    return lua_yieldk(L, 0, ctx, lw_readk);
  }
  return luaL_error(L, "io.read: no input available here and cannot wait " CANNOT_WAIT);
}

/* the original function (upvalue 1) with the same arguments */
static int lw_original (lua_State *L) {
  int n = lua_gettop(L);
  lua_pushvalue(L, lua_upvalueindex(1));
  lua_insert(L, 1);
  lua_call(L, n, LUA_MULTRET);
  return lua_gettop(L);
}

static int lw_io_read (lua_State *L) {
  int n = lua_gettop(L);
  int isin;
  lua_getfield(L, LUA_REGISTRYINDEX, "_IO_input");
  isin = lw_isstdin(L, -1);
  lua_pop(L, 1);
  if (!isin) return lw_original(L);
  luaL_checkstack(L, n + LUA_MINSTACK, "too many arguments");
  return lw_readk(L, LUA_OK, RD_CTX(n, 1, 0));
}

static int lw_f_read (lua_State *L) {
  int n = lua_gettop(L);
  if (!lw_isstdin(L, 1)) return lw_original(L);
  luaL_checkstack(L, n + LUA_MINSTACK, "too many arguments");
  return lw_readk(L, LUA_OK, RD_CTX(n, 2, 0));
}

/*
** A lines iterator over 'stdin'.  Upvalue 1 is liolib's iterator, whose
** own upvalues are, as its 'aux_lines' documents: 1 the file, 2 the
** number of formats, 3 'toclose', then the formats.
*/
static int lw_readline (lua_State *L) {
  int i, n, isin;
  lua_settop(L, 0);
  lua_getupvalue(L, lua_upvalueindex(1), 1);
  isin = lw_isstdin(L, 1);
  lua_settop(L, 0);
  if (!isin) return lw_original(L);
  lua_getupvalue(L, lua_upvalueindex(1), 2);
  n = (int)lua_tointeger(L, -1);
  lua_pop(L, 1);
  luaL_checkstack(L, n + LUA_MINSTACK, "too many arguments");
  for (i = 1; i <= n; i++) lua_getupvalue(L, lua_upvalueindex(1), 3 + i);
  return lw_readk(L, LUA_OK, RD_CTX(n, 1, 1));
}

/* wraps the iterator that the original (upvalue 1) returns */
static int lw_wraplines (lua_State *L) {
  int n = lw_original(L);
  if (n >= 1 && lua_tocfunction(L, 1) != NULL) {
    lua_pushvalue(L, 1);
    lua_pushcclosure(L, lw_readline, 1);
    lua_replace(L, 1);
  }
  return n;
}

static int lw_io_lines (lua_State *L) {
  int isin = 0;
  if (lua_isnoneornil(L, 1)) {
    lua_getfield(L, LUA_REGISTRYINDEX, "_IO_input");
    isin = lw_isstdin(L, -1);
    lua_pop(L, 1);
  }
  return isin ? lw_wraplines(L) : lw_original(L);
}

static int lw_f_lines (lua_State *L) {
  return lw_isstdin(L, 1) ? lw_wraplines(L) : lw_original(L);
}


/*
** tostring and print, as lbaselib's, but a __tostring metamethod is
** called with lua_callk.  luaL_tolstring calls it with lua_call, inside
** which no hook can yield, so a slow __tostring (in a printed value, or
** in a cell value that K.repr formats with the tostring it captured)
** could be neither sliced nor stopped: only the page's watchdog would
** end it.  Without a __tostring no Lua code runs and luaL_tolstring does
** the work, so the results and errors are lbaselib's.
*/
static int lw_tostringk (lua_State *L, int status, lua_KContext ctx) {
  (void)status; (void)ctx;
  if (!lua_isstring(L, -1))
    luaL_error(L, "'__tostring' must return a string");
  lua_tolstring(L, -1, NULL);  /* a number becomes a string, as there */
  return 1;
}

static int lw_tostring (lua_State *L) {
  luaL_checkany(L, 1);
  if (luaL_getmetafield(L, 1, "__tostring") == LUA_TNIL) {
    luaL_tolstring(L, 1, NULL);
    return 1;
  }
  lua_pushvalue(L, 1);
  lua_callk(L, 1, 1, 0, lw_tostringk);
  return lw_tostringk(L, LUA_OK, 0);
}

/* the context is the index of the argument whose __tostring was called */
static int lw_printargk (lua_State *L, int status, lua_KContext ctx) {
  int i = (int)ctx, n;
  (void)status;
  if (i > 0) {  /* argument i's __tostring returned its text */
    size_t l;
    const char *s;
    lw_tostringk(L, LUA_OK, 0);
    s = lua_tolstring(L, -1, &l);
    if (i > 1) fwrite("\t", 1, 1, stdout);  /* add a tab before it */
    fwrite(s, 1, l, stdout);
    lua_pop(L, 1);
    n = lua_gettop(L);
    i++;
  }
  else {
    n = lua_gettop(L);
    i = 1;
  }
  for (; i <= n; i++) {  /* for each argument */
    size_t l;
    const char *s;
    if (luaL_getmetafield(L, i, "__tostring") != LUA_TNIL) {
      lua_pushvalue(L, i);
      lua_callk(L, 1, 1, (lua_KContext)i, lw_printargk);
      lw_tostringk(L, LUA_OK, 0);
    }
    else luaL_tolstring(L, i, NULL);
    s = lua_tolstring(L, -1, &l);
    if (i > 1) fwrite("\t", 1, 1, stdout);
    fwrite(s, 1, l, stdout);
    lua_pop(L, 1);
  }
  fwrite("\n", 1, 1, stdout);  /* lua_writeline */
  fflush(stdout);
  return 0;
}

static int lw_print (lua_State *L) {
  return lw_printargk(L, LUA_OK, 0);
}


/* loslib's 'os_exit', ending in lw_exit */
static int lw_os_exit (lua_State *L) {
  int status;
  if (lua_isboolean(L, 1))
    status = (lua_toboolean(L, 1) ? EXIT_SUCCESS : EXIT_FAILURE);
  else
    status = (int)luaL_optinteger(L, 1, EXIT_SUCCESS);
  lw_exit(status, lua_toboolean(L, 2));
  return 0;
}

/* time spent in slices only: waiting for input or a resume is not CPU */
static int lw_os_clock (lua_State *L) {
  lua_pushnumber(L, (lua_Number)(lw_run_ms() / 1000.0));
  return 1;
}

static int lw_os_execute (lua_State *L) {
  if (lua_isnoneornil(L, 1)) {
    lua_pushboolean(L, 0);  /* no shell */
    return 1;
  }
  luaL_checkstring(L, 1);
  errno = ENOSYS;
  return luaL_fileresult(L, 0, NULL);
}


/*
** A user hook replaces the glue's on its thread only (that thread then
** neither slices nor stops).  When the original 'sethook' leaves the
** thread with no hook, the glue's is put back at once, and 'gethook'
** never shows the glue's hook.  Same thread rule as ldblib's getthread.
** A hook still set on a runner when it ends is set again on the next
** one (lw_after, lw_newrunner): lua.c runs every line on one thread, so
** a hook set at the prompt stays for the lines that follow.
*/
static lua_State *lw_hookthread (lua_State *L) {
  return lua_isthread(L, 1) ? lua_tothread(L, 1) : L;
}

static int lw_sethook (lua_State *L) {
  lua_State *L1 = lw_hookthread(L);
  lw_original(L);
  if (lua_gethook(L1) == NULL)
    lua_sethook(L1, lw_hook, LUA_MASKCOUNT, intr ? 1 : LW_HOOKCOUNT);
  return 0;
}

static int lw_gethook (lua_State *L) {
  if (lua_gethook(lw_hookthread(L)) == lw_hook) {
    luaL_pushfail(L);
    return 1;
  }
  return lw_original(L);
}


/* replaces T[NAME] (T on top of L) by F with the original as upvalue */
static void lw_wrapfield (lua_State *L, const char *name, lua_CFunction f) {
  lua_getfield(L, -1, name);
  lua_pushcclosure(L, f, 1);
  lua_setfield(L, -2, name);
}

static void lw_setfunc (lua_State *L, const char *name, lua_CFunction f) {
  lua_pushcfunction(L, f);
  lua_setfield(L, -2, name);
}

static void lw_install (lua_State *L) {
  lua_pushcfunction(L, lw_tostring);
  lua_setglobal(L, "tostring");
  lua_pushcfunction(L, lw_print);
  lua_setglobal(L, "print");
  lua_getglobal(L, "coroutine");
  lw_setfunc(L, "resume", lw_coresume);
  lw_setfunc(L, "wrap", lw_cowrap);
  lw_setfunc(L, "yield", lw_coyield);
  lw_setfunc(L, "running", lw_corunning);
  lw_setfunc(L, "isyieldable", lw_coisyieldable);
  lua_pop(L, 1);
  lua_getglobal(L, "io");
  lw_wrapfield(L, "read", lw_io_read);
  lw_wrapfield(L, "lines", lw_io_lines);
  lua_pop(L, 1);
  luaL_getmetatable(L, LUA_FILEHANDLE);
  lua_getfield(L, -1, "__index");
  if (lua_istable(L, -1)) {
    lw_wrapfield(L, "read", lw_f_read);
    lw_wrapfield(L, "lines", lw_f_lines);
  }
  lua_pop(L, 2);
  lua_getglobal(L, "os");
  lw_setfunc(L, "exit", lw_os_exit);
  lw_setfunc(L, "clock", lw_os_clock);
  lw_setfunc(L, "execute", lw_os_execute);
  lua_pop(L, 1);
  lua_getglobal(L, "debug");
  lua_getfield(L, -1, "sethook");
  lua_setfield(L, LUA_REGISTRYINDEX, KEY_SETHOOK);
  lua_getfield(L, -1, "gethook");
  lua_setfield(L, LUA_REGISTRYINDEX, KEY_GETHOOK);
  lw_wrapfield(L, "sethook", lw_sethook);
  lw_wrapfield(L, "gethook", lw_gethook);
  lua_pop(L, 1);
}

/* }================================================================== */


/*
** {==================================================================
** The notebook module's C primitives ('core', see notebook.lua)
** ===================================================================
*/

static int lw_core_display (lua_State *L) {
  size_t mlen, dlen, idlen = 0;
  const char *mime = luaL_checklstring(L, 1, &mlen);
  const char *data = luaL_checklstring(L, 2, &dlen);
  const char *id = luaL_optlstring(L, 3, NULL, &idlen);
  if (mode == MODE_KERNEL)
    lw_display(mime, mlen, data, dlen, id, idlen);
  else if (strcmp(mime, "text/plain") == 0 || strcmp(mime, "text/markdown") == 0) {
    fwrite(data, 1, dlen, stdout);
    fputc('\n', stdout);
  }
  else {
    fflush(stdout);
    printf("<%s, %zu bytes: open the Notebook tab to see it>\n", mime, dlen);
  }
  return 0;
}

static int lw_core_clear (lua_State *L) {
  (void)L;
  if (mode == MODE_KERNEL) {
    char tmp[64];
    snprintf(tmp, sizeof(tmp), "{\"ev\":\"clear\",\"rid\":%ld}", cell_rid);
    lw_event_lit(tmp);
  }
  return 0;
}

static int lw_sleepk (lua_State *L, int status, lua_KContext ctx) {
  (void)status; (void)ctx;
  if (intr) return luaL_error(L, "interrupted!");
  return 0;
}

static int lw_core_sleep (lua_State *L) {
  lua_Number s = luaL_checknumber(L, 1);
  if (intr) return luaL_error(L, "interrupted!");
  if (!(s > 0)) return 0;
  if (!lw_hostyieldable(L))
    return luaL_error(L, "notebook.sleep: cannot wait here " CANNOT_WAIT);
  wake_at = lw_now() + 1000.0 * (double)s;
  hy = HY_SLEEP;
  return lua_yieldk(L, 0, 0, lw_sleepk);
}

static int lw_core_base64 (lua_State *L) {
  static const char tab[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t len, i;
  const unsigned char *s = (const unsigned char *)luaL_checklstring(L, 1, &len);
  luaL_Buffer b;
  luaL_buffinit(L, &b);
  for (i = 0; i + 2 < len; i += 3) {
    char *q = luaL_prepbuffsize(&b, 4);
    q[0] = tab[s[i] >> 2];
    q[1] = tab[((s[i] & 3) << 4) | (s[i + 1] >> 4)];
    q[2] = tab[((s[i + 1] & 15) << 2) | (s[i + 2] >> 6)];
    q[3] = tab[s[i + 2] & 63];
    luaL_addsize(&b, 4);
  }
  if (i < len) {
    char *q = luaL_prepbuffsize(&b, 4);
    q[0] = tab[s[i] >> 2];
    if (i + 1 < len) {
      q[1] = tab[((s[i] & 3) << 4) | (s[i + 1] >> 4)];
      q[2] = tab[(s[i + 1] & 15) << 2];
    }
    else {
      q[1] = tab[(s[i] & 3) << 4];
      q[2] = '=';
    }
    q[3] = '=';
    luaL_addsize(&b, 4);
  }
  luaL_pushresult(&b);
  return 1;
}

static void lw_pushcore (lua_State *L) {
  lua_createtable(L, 0, 7);
  lw_setfunc(L, "display", lw_core_display);
  lw_setfunc(L, "clear", lw_core_clear);
  lw_setfunc(L, "sleep", lw_core_sleep);
  lw_setfunc(L, "base64", lw_core_base64);
  lua_pushboolean(L, mode == MODE_KERNEL);
  lua_setfield(L, -2, "kernel");
  lua_pushstring(L, sizeof(void *) == 8 ? "wasm64" : "wasm32");
  lua_setfield(L, -2, "arch");
  lua_pushliteral(L, LUA_RELEASE);
  lua_setfield(L, -2, "version");
}

/*
** Loads notebook.lua with 'core' and returns its module M, keeping the
** formatters of its second result K in the registry.  It is also
** package.preload.notebook (so "require" runs it in console mode too).
*/
static int lw_nbload (lua_State *L) {
  if (luaL_loadfilex(L, LW_NBFILE, "t") != LUA_OK)
    return lua_error(L);
  lw_pushcore(L);
  lua_call(L, 1, 2);
  if (lua_istable(L, -1)) {
    lua_getfield(L, -1, "repr");
    lua_setfield(L, LUA_REGISTRYINDEX, KEY_REPR);
    lua_getfield(L, -1, "display");
    lua_setfield(L, LUA_REGISTRYINDEX, KEY_DISPLAY);
  }
  lua_pop(L, 1);
  return 1;
}

/* }================================================================== */


/*
** {==================================================================
** The runner: body, message handler, results
** ===================================================================
*/

/* startup jobs, in lua.c's order (handle_luainit, runargs, handle_script) */
enum { JOB_INIT, JOB_WARNOFF, JOB_WARNON, JOB_STAT, JOB_LIB, JOB_SCRIPT };
struct job {
  int kind;
  char *arg;		/* code, @file, the module name, the script */
  char *glob;		/* JOB_LIB: the global that gets the module */
  const char *name;	/* chunk name (JOB_INIT, JOB_STAT) */
};
static struct job *jobs;
static int njobs, jobpos, jobs_done, job_failed;
static struct job *cur_job;
static int init_job;		/* an init job existed (kernel: 'init' event) */


/*
** lua.c's 'msghandler' verbatim, after two statements: the error now
** goes to the glue's own protected call and the chunk is ending, so the
** Stop is over and __close handlers and a __tostring run uninterrupted
** (lua.c's 'lstop' disarms itself for the same reason); and the kernel
** keeps the message without the traceback for its ErrorObj.
*/
/* kernel: the message on top, kept (the key exists: no allocation) */
static void lw_keep_errtext (lua_State *L) {
  if (mode == MODE_KERNEL) {
    lua_pushvalue(L, -1);
    lua_setfield(L, LUA_REGISTRYINDEX, KEY_ERRTEXT);
  }
}

static int lw_msgh (lua_State *L) {
  const char *msg;
  intr = 0;
  lua_sethook(L, lw_hook, LUA_MASKCOUNT, LW_HOOKCOUNT);
  msg = lua_tostring(L, 1);
  if (msg == NULL) {  /* is error object not a string? */
    if (luaL_callmeta(L, 1, "__tostring") &&  /* does it have a metamethod */
        lua_type(L, -1) == LUA_TSTRING) {  /* that produces a string? */
      lw_keep_errtext(L);
      return 1;  /* that is the message */
    }
    else
      msg = lua_pushfstring(L, "(error object is a %s value)",
                               luaL_typename(L, 1));
  }
  else lua_pushvalue(L, 1);
  lw_keep_errtext(L);
  luaL_traceback(L, L, msg, 1);  /* append a standard traceback */
  return 1;  /* return the traceback */
}


/* the end of a startup job that failed: lua.c's 'report', progname lua */
static void lw_job_error (lua_State *L, int status) {
  size_t len;
  const char *msg = lw_errmsg(L, &len);
  job_failed = 1;
  if (mode == MODE_KERNEL && cur_job->kind == JOB_INIT) {
    const char *name = cur_job->arg[0] == '@' ? cur_job->arg + 1 : cur_job->name + 1;
    jb_free(&init_jb);
    jb_lit(&init_jb, "{\"ev\":\"init\",\"status\":\"error\",\"error\":");
    jb_runerror(&init_jb, L, status, NULL, name);
    jb_lit(&init_jb, "}");
  }
  else lw_message(LW_PROGNAME, msg);
}


/* lua.c's 'l_print' result: the 'print' call failed */
static int lw_printk (lua_State *L, int status, lua_KContext ctx) {
  (void)ctx;
  if (status != LUA_OK && status != LUA_YIELD)
    lw_message(NULL, lua_pushfstring(L, "error calling 'print' (%s)",
                                        lua_tostring(L, -1)));
  return 0;
}


/*
** A cell's results, formatted in order by K.display and K.repr, each
** called with lua_pcallk so that a slow __tostring is sliced and can be
** stopped.  The results are at 2..cell_nres+1 (1 is the message
** handler), the kept repr strings are appended above them.  The
** context packs the result index, the phase (display or repr) and
** whether a call was just made.
*/
#define FMT_CALLED	1
#define FMT_REPR	2

static void lw_fmt_error (lua_State *L, int status) {
  size_t len;
  const char *msg = lw_errmsg(L, &len);
  if (status == LUA_ERRMEM) { msg = "not enough memory"; len = strlen(msg); }
  lw_done_error(cell_intr ? "interrupted" : "error",
                cell_intr ? "interrupted" : lw_kind(status), msg, len, msg, len, 1);
}

static int lw_fmtk (lua_State *L, int status, lua_KContext ctx) {
  int i, top;
  for (;;) {
    i = (int)(ctx >> 2);
    if (ctx & FMT_CALLED) {  /* a formatter returned */
      if (status != LUA_OK && status != LUA_YIELD) {
        lw_fmt_error(L, status);
        return 0;
      }
      if (!(ctx & FMT_REPR)) {  /* K.display: mime, data, id */
        if (lua_type(L, -3) == LUA_TSTRING && lua_type(L, -2) == LUA_TSTRING) {
          size_t ml, dl, il = 0;
          const char *mime = lua_tolstring(L, -3, &ml);
          const char *data = lua_tolstring(L, -2, &dl);
          const char *id = lua_type(L, -1) == LUA_TSTRING ? lua_tolstring(L, -1, &il) : NULL;
          lw_display(mime, ml, data, dl, id, il);
          lua_pop(L, 3);
          ctx = (lua_KContext)(i + 1) << 2;
        }
        else {
          lua_pop(L, 3);
          ctx = ((lua_KContext)i << 2) | FMT_REPR;
        }
      }
      else {  /* K.repr: the string stays on the stack */
        if (lua_type(L, -1) != LUA_TSTRING) {
          lua_pop(L, 1);
          lua_pushliteral(L, "?");
        }
        ctx = (lua_KContext)(i + 1) << 2;
      }
      i = (int)(ctx >> 2);
    }
    if (i >= cell_nres) break;
    lua_getfield(L, LUA_REGISTRYINDEX, (ctx & FMT_REPR) ? KEY_REPR : KEY_DISPLAY);
    lua_pushvalue(L, 2 + i);
    ctx |= FMT_CALLED;
    status = lua_pcallk(L, 1, (ctx & FMT_REPR) ? 1 : 3, 0, ctx, lw_fmtk);
  }
  /* the values: done is serialised now, while the strings are on the stack */
  top = lua_gettop(L);
  lw_done_begin(cell_intr ? "interrupted" : "ok");
  if (top == cell_nres + 1) jb_lit(&done_jb, "null");
  else {
    jb_lit(&done_jb, "[");
    for (i = cell_nres + 2; i <= top; i++) {
      size_t len;
      const char *s = lua_tolstring(L, i, &len);
      if (i > cell_nres + 2) jb_lit(&done_jb, ",");
      jb_str(&done_jb, s, len);
    }
    jb_lit(&done_jb, "]");
  }
  jb_lit(&done_jb, "}");
  return 0;
}

static int lw_cellres (lua_State *L, int status) {
  if (status != LUA_OK) {  /* the chunk failed: the handler's result on top */
    lw_done_begin(cell_intr ? "interrupted" : "error");
    jb_lit(&done_jb, "null,\"error\":");
    jb_runerror(&done_jb, L, status, cell_intr ? "interrupted" : NULL, cell_name);
    jb_lit(&done_jb, "}");
    lw_clear_errtext(L);
    return 0;
  }
  cell_nres = lua_gettop(L) - 1;
  luaL_checkstack(L, cell_nres + LUA_MINSTACK, "too many results to print");
  return lw_fmtk(L, LUA_OK, 0);
}


/*
** The runner's body continuation: the chunk returned (results above the
** handler at 1), or failed (the handler's result on top).  Returns 0,
** so the runner ends with LUA_OK unless this reporting raised.
*/
static int lw_bodyk (lua_State *L, int status, lua_KContext ctx) {
  (void)ctx;
  if (status == LUA_YIELD) status = LUA_OK;
  switch (work) {
    case WK_LINE: {
      int n = lua_gettop(L) - 1;
      if (status != LUA_OK) {  /* lua.c's 'report', with no progname */
        size_t len;
        lw_message(NULL, lw_errmsg(L, &len));
      }
      else if (n > 0) {  /* lua.c's 'l_print', yieldable */
        luaL_checkstack(L, LUA_MINSTACK, "too many results to print");
        lua_getglobal(L, "print");
        lua_insert(L, 2);
        return lw_printk(L, lua_pcallk(L, n, 0, 0, 0, lw_printk), 0);
      }
      return 0;
    }
    case WK_JOB:
      if (status != LUA_OK)
        lw_job_error(L, status);
      else if (cur_job->kind == JOB_LIB) {
        lua_settop(L, 2);  /* the first result of 'require' */
        lua_setglobal(L, cur_job->glob);  /* globname = require(modname) */
      }
      return 0;
    default:
      return lw_cellres(L, status);
  }
}

static int lw_body (lua_State *L) {
  int n = lua_gettop(L);  /* the function and its arguments */
  lua_pushcfunction(L, lw_msgh);
  lua_insert(L, 1);
  return lw_bodyk(L, lua_pcallk(L, n - 1, LUA_MULTRET, 1, 0, lw_bodyk), 0);
}


/*
** A new runner for the function and its N-1 arguments on top of L (G,
** inside lw_protect).  Threads the user creates from it inherit its hook.
** It gets the glue's hook, or the user hook the previous runner ended
** with, set through the original debug.sethook, which keeps the Lua
** function in ldblib's table of hooks (a lua_sethook copy would not).
*/
static void lw_newrunner (lua_State *L, int n, int wk) {
  lua_State *R = lua_newthread(L);
  lua_insert(L, -(n + 1));  /* the thread below the function */
  if (!lua_checkstack(R, n + 1))
    luaL_error(L, "stack overflow (too many arguments to script)");
  lua_sethook(R, lw_hook, LUA_MASKCOUNT, LW_HOOKCOUNT);
  if (lua_getfield(L, LUA_REGISTRYINDEX, KEY_HOOK) == LUA_TTABLE) {
    int t = lua_gettop(L);
    lua_getfield(L, LUA_REGISTRYINDEX, KEY_SETHOOK);
    lua_pushvalue(L, t - n - 1);  /* R */
    lua_rawgeti(L, t, 1);  /* function */
    lua_rawgeti(L, t, 2);  /* mask */
    lua_rawgeti(L, t, 3);  /* count */
    lua_call(L, 4, 0);
  }
  lua_pop(L, 1);
  lua_pushcfunction(R, lw_body);
  lua_xmove(L, R, n);
  runner_ref = luaL_ref(L, LUA_REGISTRYINDEX);
  runner = R;
  rnargs = n;
  work = wk;
}

/*
** A user hook on R, as the original debug.gethook gives it (function,
** mask, count), in KEY_HOOK for the next runner; nil there otherwise
*/
static void lw_keephook (lua_State *L, lua_State *R) {
  lua_Hook h = lua_gethook(R);
  lua_pushnil(L);
  if (h != NULL && h != lw_hook) {
    lua_pop(L, 1);
    lua_getfield(L, LUA_REGISTRYINDEX, KEY_GETHOOK);
    lua_rawgeti(L, LUA_REGISTRYINDEX, runner_ref);  /* R */
    lua_call(L, 1, 3);
    if (lua_isfunction(L, -3)) {  /* (not an "external hook") */
      lua_createtable(L, 3, 0);
      lua_insert(L, -4);
      lua_rawseti(L, -4, 3);
      lua_rawseti(L, -3, 2);
      lua_rawseti(L, -2, 1);
    }
    else {
      lua_pop(L, 3);
      lua_pushnil(L);
    }
  }
  lua_setfield(L, LUA_REGISTRYINDEX, KEY_HOOK);
}

/* after the runner ends (lw_finish) */
static int lw_after (lua_State *L) {
  if (runner != NULL) {
    lw_keephook(L, runner);
    lua_closethread(runner, L);
  }
  luaL_unref(L, LUA_REGISTRYINDEX, runner_ref);
  runner_ref = LUA_NOREF;
  if (mode == MODE_KERNEL && work == WK_CELL) {
    lua_getfield(L, LUA_REGISTRYINDEX, KEY_IOOUTPUT);
    lua_getfield(L, LUA_REGISTRYINDEX, KEY_STDOUT);
    lua_call(L, 1, 0);
    lua_getfield(L, LUA_REGISTRYINDEX, KEY_IOINPUT);
    lua_getfield(L, LUA_REGISTRYINDEX, KEY_STDIN);
    lua_call(L, 1, 0);
  }
  return 0;
}

/* }================================================================== */


/*
** {==================================================================
** Startup: arguments, state, jobs
** ===================================================================
*/

/* lua.c's 'print_usage', the first line given */
static void lw_usage (const char *first) {
  fprintf(stderr, "%s: %s\n", LW_PROGNAME, first);
  fprintf(stderr,
  "usage: %s [options] [script [args]]\n"
  "Available options are:\n"
  "  -e stat   execute string 'stat'\n"
  "  -i        enter interactive mode after executing 'script'\n"
  "  -l mod    require library 'mod' into global 'mod'\n"
  "  -l g=mod  require library 'mod' into global 'g'\n"
  "  -v        show version information\n"
  "  -E        ignore environment variables\n"
  "  -W        turn warnings on\n"
  "  --        stop handling options\n"
  "  -         stop handling options and execute stdin\n"
  ,
  LW_PROGNAME);
  fflush(stderr);
}

#define has_error	1
#define has_E		16

/*
** lua.c's 'collectargs', after an optional "--notebook" as argv[1].
** 'first' gets the index of the bad argument, of the script, or 0.
*/
static int lw_collectargs (char **argv, int *first) {
  int args = 0;
  int i = 1;
  if (argv[1] != NULL && strcmp(argv[1], "--notebook") == 0) {
    mode = MODE_KERNEL;
    i = 2;
  }
  for (; argv[i] != NULL; i++) {
    *first = i;
    if (argv[i][0] != '-')  /* not an option? */
        return args;  /* stop handling options */
    switch (argv[i][1]) {  /* else check option */
      case '-':  /* '--' */
        if (argv[i][2] != '\0')  /* extra characters after '--'? */
          return has_error;  /* invalid option */
        /* if there is a script name, it comes after '--' */
        *first = (argv[i + 1] != NULL) ? i + 1 : 0;
        return args;
      case '\0':  /* '-' */
        return args;  /* script "name" is '-' */
      case 'E':
        if (argv[i][2] != '\0')  /* extra characters? */
          return has_error;  /* invalid option */
        args |= has_E;
        break;
      case 'W': case 'i': case 'v':
        if (argv[i][2] != '\0')  /* extra characters? */
          return has_error;  /* invalid option */
        break;
      case 'e': case 'l':  /* both options need an argument */
        if (argv[i][2] == '\0') {  /* no concatenated argument? */
          i++;  /* try next 'argv' */
          if (argv[i] == NULL || argv[i][0] == '-')
            return has_error;  /* no next argument or it is another option */
        }
        break;
      default:  /* invalid option */
        return has_error;
    }
  }
  *first = 0;  /* no script name */
  return args;
}


/* lua.c's 'createargtable' */
static void lw_createargtable (lua_State *L, char **argv, int argc, int script) {
  int i, narg;
  narg = argc - (script + 1);  /* number of positive indices */
  lua_createtable(L, narg, script + 1);
  for (i = 0; i < argc; i++) {
    lua_pushstring(L, argv[i]);
    lua_rawseti(L, -2, i - script);
  }
  lua_setglobal(L, "arg");
}

struct margs { int argc; char **argv; int script; int flags; };

/* lua.c's 'pmain', up to the code it runs (that is queued as jobs) */
static int lw_pmain (lua_State *L) {
  struct margs *a = (struct margs *)lua_touserdata(L, 1);
  luaL_checkversion(L);  /* check that interpreter has correct version */
  if (a->flags & has_E) {  /* option '-E'? */
    lua_pushboolean(L, 1);  /* signal for libraries to ignore env. vars. */
    lua_setfield(L, LUA_REGISTRYINDEX, "LUA_NOENV");
  }
  luaL_openlibs(L);  /* open standard libraries */
  lw_createargtable(L, a->argv, a->argc, a->script);  /* create table 'arg' */
  lua_gc(L, LUA_GCRESTART);  /* start GC... */
  lua_gc(L, LUA_GCGEN);  /* ...in generational mode */
  /* the glue's registry fields that are written without allocating */
  lua_pushboolean(L, 0);
  lua_setfield(L, LUA_REGISTRYINDEX, KEY_ERRTEXT);
  lua_pushboolean(L, 0);
  lua_setfield(L, LUA_REGISTRYINDEX, KEY_PENDING);
  lw_install(L);
  luaL_getsubtable(L, LUA_REGISTRYINDEX, LUA_PRELOAD_TABLE);
  lua_pushcfunction(L, lw_nbload);
  lua_setfield(L, -2, "notebook");
  lua_pop(L, 1);
  if (mode == MODE_KERNEL) {
    /* the kernel's reporting must survive whatever cells do */
    lua_getglobal(L, "io");
    lua_getfield(L, -1, "output");
    lua_setfield(L, LUA_REGISTRYINDEX, KEY_IOOUTPUT);
    lua_getfield(L, -1, "input");
    lua_setfield(L, LUA_REGISTRYINDEX, KEY_IOINPUT);
    lua_getfield(L, -1, "stdout");
    lua_setfield(L, LUA_REGISTRYINDEX, KEY_STDOUT);
    lua_getfield(L, -1, "stdin");
    lua_setfield(L, LUA_REGISTRYINDEX, KEY_STDIN);
    lua_pop(L, 1);
    lua_pushcfunction(L, lw_nbload);
    lua_call(L, 0, 1);
    luaL_getsubtable(L, LUA_REGISTRYINDEX, LUA_LOADED_TABLE);
    lua_pushvalue(L, -2);
    lua_setfield(L, -2, "notebook");
    lua_pop(L, 1);
    lua_setglobal(L, "notebook");
  }
  else {
    fwrite(LUA_COPYRIGHT, 1, strlen(LUA_COPYRIGHT), stdout);  /* print_version */
    fputc('\n', stdout);
    fflush(stdout);
  }
  return 0;
}


static char *lw_strdup (const char *s) {
  char *d = strdup(s);
  if (d == NULL) {
    lw_message(LW_PROGNAME, "not enough memory");
    exited = 1;
    exit_code = 1;
  }
  return d;
}

static int lw_addjob (int kind, const char *arg, const char *name) {
  struct job *j = &jobs[njobs++];
  j->kind = kind;
  j->arg = j->glob = NULL;
  j->name = name;
  if (arg != NULL && (j->arg = lw_strdup(arg)) == NULL) return 0;
  if (kind == JOB_LIB) {  /* lua.c's 'dolibrary': globname[=modname] */
    char *eq = strchr(j->arg, '=');
    if (eq != NULL) {  /* explicit global name */
      *eq = '\0';
      j->glob = j->arg;
      if ((j->arg = lw_strdup(eq + 1)) == NULL) return 0;
    }
    else {  /* the module name, cut at its version mark */
      char *suffix;
      if ((j->glob = lw_strdup(j->arg)) == NULL) return 0;
      if ((suffix = strchr(j->glob, *LUA_IGMARK)) != NULL) *suffix = '\0';
    }
  }
  return 1;
}

/* the jobs, in lua.c's order; argv's strings are copied (main returns) */
static int lw_queuejobs (char **argv, int argc, int script, int flags) {
  int i, optlim = (script > 0) ? script : argc;
  if ((jobs = malloc(sizeof(struct job) * (size_t)(argc + 3))) == NULL) {
    lw_message(LW_PROGNAME, "not enough memory");
    return 0;
  }
  if (!(flags & has_E)) {  /* lua.c's 'handle_luainit' */
    const char *name = "=" LW_INIT_VAR LUA_VERSUFFIX;
    const char *init = getenv(name + 1);
    if (init == NULL) {
      name = "=" LW_INIT_VAR;
      init = getenv(name + 1);  /* try alternative name */
    }
    if (init != NULL) {
      if (!lw_addjob(JOB_INIT, init, name)) return 0;
      init_job = 1;
    }
  }
  lw_addjob(JOB_WARNOFF, NULL, NULL);  /* lua.c's 'runargs' */
  for (i = (mode == MODE_KERNEL) ? 2 : 1; i < optlim; i++) {
    int option = argv[i][1];
    if (option == 'e' || option == 'l') {
      const char *extra = argv[i] + 2;  /* both options need an argument */
      if (*extra == '\0') extra = argv[++i];
      if (!lw_addjob(option == 'e' ? JOB_STAT : JOB_LIB, extra, "=(command line)"))
        return 0;
    }
    else if (option == 'W')
      lw_addjob(JOB_WARNON, NULL, NULL);
  }
  if (script > 0 && !lw_addjob(JOB_SCRIPT, argv[script], NULL))
    return 0;
  return 1;
}

/* }================================================================== */


/*
** {==================================================================
** Units of work: jobs, REPL lines, cells
** ===================================================================
*/

/* lua.c's 'pushargs': the script's arguments, from the global 'arg' */
static int lw_pushargs (lua_State *L) {
  int i, n;
  if (lua_getglobal(L, "arg") != LUA_TTABLE)
    luaL_error(L, "'arg' is not a table");
  n = (int)luaL_len(L, -1);
  luaL_checkstack(L, n + 3, "too many arguments to script");
  for (i = 1; i <= n; i++)
    lua_rawgeti(L, -i, i);
  lua_remove(L, -i);  /* remove table from the stack */
  return n;
}

/* prepares the runner of cur_job; a load failure is the job's failure */
static int lw_jobprep (lua_State *L) {
  struct job *j = cur_job;
  int status, n = 1;
  switch (j->kind) {
    case JOB_INIT:
      if (j->arg[0] == '@')
        status = luaL_loadfilex(L, j->arg + 1, "bt");
      else
        status = luaL_loadbufferx(L, j->arg, strlen(j->arg), j->name, "t");
      break;
    case JOB_STAT:
      status = luaL_loadbufferx(L, j->arg, strlen(j->arg), j->name, "t");
      break;
    case JOB_LIB:
      lua_getglobal(L, "require");
      lua_pushstring(L, j->arg);
      status = LUA_OK;
      n = 2;
      break;
    default:  /* JOB_SCRIPT */
      status = luaL_loadfilex(L, j->arg, "bt");
      if (status == LUA_OK) n += lw_pushargs(L);
      break;
  }
  if (status != LUA_OK) {
    lw_job_error(L, status);
    return 0;
  }
  lw_newrunner(L, n, WK_JOB);
  return 0;
}

static void lw_jobs_end (void);

/*
** Runs the jobs that need no runner (warning controls) up to the next
** one that does, and prepares it.  Returns 1 when a runner is ready, 0
** when the jobs are over.
*/
static int lw_nextjob (void) {
  while (jobpos < njobs) {
    struct job *j = &jobs[jobpos++];
    int status;
    if (j->kind == JOB_WARNOFF) { lua_warning(G, "@off", 0); continue; }
    if (j->kind == JOB_WARNON) { lua_warning(G, "@on", 0); continue; }
    cur_job = j;
    job_failed = 0;
    if ((status = lw_protect(lw_jobprep, NULL)) != LUA_OK) {
      lw_job_error(G, status);  /* (memory: the message is the fixed one) */
      lua_settop(G, 0);
    }
    if (runner != NULL) return 1;
    if (job_failed && mode == MODE_REPL) lw_exit(EXIT_FAILURE, 1);
  }
  if (!jobs_done) lw_jobs_end();
  return 0;
}

/* kernel: 'init' (when there was an init job), then 'hello' */
static void lw_jobs_end (void) {
  char tmp[128];
  jobs_done = 1;
  if (mode != MODE_KERNEL) return;
  if (init_job) {
    if (init_jb.p == NULL && !init_jb.oom)  /* (the job never got to report) */
      jb_lit(&init_jb, "{\"ev\":\"init\",\"status\":\"error\"}");
    lw_event(&init_jb, 0);
  }
  snprintf(tmp, sizeof(tmp), "{\"ev\":\"hello\",\"proto\":1,\"version\":\"%s\",\"arch\":\"%s\"}",
           LUA_RELEASE, sizeof(void *) == 8 ? "wasm64" : "wasm32");
  lw_event_lit(tmp);
}


/* REPL: lua.c's 'get_prompt' written to fd 4 */
static int lw_promptf (lua_State *L) {
  int firstline = (*(int *)lua_touserdata(L, 1) == 1);
  const char *p;
  if (lua_getglobal(L, firstline ? "_PROMPT" : "_PROMPT2") == LUA_TNIL)
    p = firstline ? "> " : ">> ";  /* use the default */
  else  /* apply 'tostring' over the value */
    p = luaL_tolstring(L, -1, NULL);
  lw_emit(4, p, strlen(p));
  return 0;
}

static void lw_write_prompt (int level) {
  if (lw_protect(lw_promptf, &level) != LUA_OK) {  /* the default, silently */
    lua_settop(G, 0);
    lw_emit(4, level == 1 ? "> " : ">> ", level == 1 ? 2 : 3);
  }
  prompt = level;
}


/* lua.c's 'incomplete' */
#define EOFMARK		"<eof>"
#define marklen		(sizeof(EOFMARK)/sizeof(char) - 1)

static int lw_incomplete (lua_State *L, int status) {
  if (status == LUA_ERRSYNTAX) {
    size_t lmsg;
    const char *msg = lua_tolstring(L, -1, &lmsg);
    if (lmsg >= marklen && strcmp(msg + lmsg - marklen, EOFMARK) == 0)
      return 1;
  }
  return 0;  /* else... */
}

/* lua.c's 'checklocal' */
static void lw_checklocal (const char *line) {
  static const size_t szloc = sizeof("local") - 1;
  static const char space[] = " \t";
  line += strspn(line, space);  /* skip spaces */
  if (strncmp(line, "local", szloc) == 0 &&  /* "local"? */
      strchr(space, *(line + szloc)) != NULL) {  /* followed by a space? */
    lw_message(NULL, "warning: locals do not survive across lines in interactive mode");
  }
}

static void lw_setpending (lua_State *L, int idx) {
  lua_pushvalue(L, idx);
  lua_setfield(L, LUA_REGISTRYINDEX, KEY_PENDING);
}

static void lw_clearpending (lua_State *L) {
  lua_pushboolean(L, 0);
  lua_setfield(L, LUA_REGISTRYINDEX, KEY_PENDING);
  ml_pending = 0;
}


/*
** One REPL line from 'stdin', then lua.c's 'loadline', 'addreturn' and
** 'multiline' cut into steps: an incomplete statement is kept in the
** registry until the next line comes (prompt 2).
*/
static int lw_getline (lua_State *L) {
  ssize_t n;
  size_t len;
  const char *line, *text;
  int status;
  clearerr(stdin);
  n = getline(&lbuf, &lcap, stdin);
  if (n < 0) return 0;  /* no input after all */
  if (n > 0 && lbuf[n - 1] == '\n')  /* line ends with newline? */
    n--;  /* remove it */
  line = lua_pushlstring(L, lbuf, (size_t)n);  /* at 2 */
  if (!ml_pending) {
    /* lua.c's 'addreturn' */
    const char *retline = lua_pushfstring(L, "return %s;", line);
    status = luaL_loadbufferx(L, retline, strlen(retline), "=stdin", "t");
    if (status == LUA_OK) {
      lw_newrunner(L, 1, WK_LINE);
      return 0;
    }
    lua_pop(L, 2);  /* pop result from 'luaL_loadbufferx' and modified line */
    lw_checklocal(line);
  }
  else {  /* a continuation line: join the two lines */
    lua_getfield(L, LUA_REGISTRYINDEX, KEY_PENDING);
    lua_pushliteral(L, "\n");
    lua_pushvalue(L, 2);
    lua_concat(L, 3);
    lua_replace(L, 2);
  }
  text = lua_tolstring(L, 2, &len);
  status = luaL_loadbufferx(L, text, len, "=stdin", "t");  /* try it */
  if (lw_incomplete(L, status)) {
    lw_setpending(L, 2);
    ml_pending = 1;
    return 0;
  }
  lw_clearpending(L);
  if (status == LUA_OK)
    lw_newrunner(L, 1, WK_LINE);
  else {  /* lua.c's 'report', with no progname */
    size_t ml;
    lw_message(NULL, lw_errmsg(L, &ml));
  }
  return 0;
}

/* EOF at '>>': lua.c's 'multiline' gets no line and reports the text */
static int lw_eofpending (lua_State *L) {
  size_t len;
  const char *text;
  int status;
  lua_getfield(L, LUA_REGISTRYINDEX, KEY_PENDING);
  text = lua_tolstring(L, -1, &len);
  if (text != NULL) {
    status = luaL_loadbufferx(L, text, len, "=stdin", "t");
    if (status != LUA_OK) {
      size_t ml;
      lw_message(NULL, lw_errmsg(L, &ml));
    }
  }
  lw_clearpending(L);
  return 0;
}

static int lw_clearpendingf (lua_State *L) {
  lw_clearpending(L);
  return 0;
}


/*
** The REPL's next step when no runner is active.  Returns 1 when there
** is more to do in this slice, 0 when it waits (state set).
*/
static int lw_repl_next (void) {
  int status;
  if (intr && ml_pending) {  /* Stop at '>>': the statement is dropped */
    if (lw_protect(lw_clearpendingf, NULL) != LUA_OK) lua_settop(G, 0);
    ml_pending = 0;
    fputc('\n', stdout);
    fflush(stdout);
    prompt = 0;
    intr = 0;  /* the Stop is spent: a line already queued runs as usual */
  }
  if (!lw_line_ready()) {
    if (in_eof) {  /* EOF with nothing to read: the end, as lua.c's doREPL */
      if (ml_pending) {
        if (lw_protect(lw_eofpending, NULL) != LUA_OK) lua_settop(G, 0);
        ml_pending = 0;
        lw_write_prompt(1);  /* lua.c's loop prompts again, and reads EOF */
      }
      fputc('\n', stdout);  /* lua_writeline */
      fflush(stdout);
      lw_exit(EXIT_SUCCESS, 1);
    }
    if (prompt == 0) lw_write_prompt(ml_pending ? 2 : 1);
    state = WEBREPL_WAITING;
    intr = 0;  /* no chunk runs: a later Stop must not hit the next one */
    return 0;
  }
  prompt = 0;
  if ((status = lw_protect(lw_getline, NULL)) != LUA_OK) {
    lw_glue_fail(status);
    ml_pending = 0;
    if (lw_protect(lw_clearpendingf, NULL) != LUA_OK) lua_settop(G, 0);
  }
  return 1;
}


/*
** A cell: "return SRC;", else SRC with the last-expression split, else
** SRC as is, else the split alone, as emscripten/README.md describes.
** Leaves a runner, or the cell's 'done' (a syntax error or an incomplete
** cell) in done_jb.
*/
struct cellsrc { const char *src; size_t len; };

/* does S compile?  (nothing is left on the stack) */
static int lw_compiles (lua_State *L, const char *s, size_t len) {
  int status = luaL_loadbufferx(L, s, len, "=cell", "t");
  lua_pop(L, 1);
  return status == LUA_OK;
}

/* pushes "return S;" */
static const char *lw_pushreturn (lua_State *L, const char *s, size_t len, size_t *rlen) {
  luaL_Buffer b;
  luaL_buffinit(L, &b);
  luaL_addstring(&b, "return ");
  luaL_addlstring(&b, s, len);
  luaL_addchar(&b, ';');
  luaL_pushresult(&b);
  return lua_tolstring(L, -1, rlen);
}

/* string.dump's writer (lstrlib), for lw_dump */
struct lw_writer { int init; luaL_Buffer B; };

static int lw_writer (lua_State *L, const void *b, size_t size, void *ud) {
  struct lw_writer *w = (struct lw_writer *)ud;
  if (!w->init) {
    w->init = 1;
    luaL_buffinit(L, &w->B);
  }
  if (b == NULL) {  /* the end of the dump */
    luaL_pushresult(&w->B);
    lua_replace(L, 1);
  }
  else
    luaL_addlstring(&w->B, (const char *)b, size);
  return 0;
}

/* string.dump(f, true), for the function at 1 */
static int lw_dump (lua_State *L) {
  struct lw_writer w;
  lua_pushvalue(L, 1);
  w.init = 0;
  lua_dump(L, lw_writer, &w, 1);
  lua_settop(L, 1);
  return 1;
}

/* pushes the stripped binary chunk of the function at IDX */
static void lw_pushdump (lua_State *L, int idx) {
  idx = lua_absindex(L, idx);
  lua_pushcfunction(L, lw_dump);
  lua_pushvalue(L, idx);
  lua_call(L, 1, 1);
}

/*
** The last-expression split of SRC: lines 1..k-1 as statements, then
** "return <lines k..last>;", k from the last non-blank line up to 19
** lines above it, keeping the line numbers.  CHUNK is the index of the
** chunk name.  ORIG, when not 0, is the index of SRC compiled: SRC is a
** chunk, so a split must not change what it does, and it is taken only
** when "<lines 1..k-1>\n;<lines k..last>" compiles to the same code.
** The ';' (which compiles to nothing) then stood between two of SRC's
** statements, so lines k..last were its last statement, and returning
** them runs SRC as written plus its value.  ("x = f" and then "(1)" is
** one call, x = f(1): with the ';', "(1)" is not a statement.)  Leaves
** a runner and returns 1, or returns 0 with the stack as it was.
*/
static int lw_split (lua_State *L, const char *src, size_t len, int chunk, int orig) {
  const char *name = lua_tostring(L, chunk), *s;
  size_t nlines = 1, i, last, k, kmin, slen;
  size_t *starts;
  int top = lua_gettop(L), base;
  if (orig) lw_pushdump(L, orig);  /* at top + 1 */
  for (i = 0; i < len; i++) if (src[i] == '\n') nlines++;
  starts = (size_t *)lua_newuserdatauv(L, sizeof(size_t) * (nlines + 1), 0);
  base = lua_gettop(L);
  starts[0] = 0;
  for (i = 0, k = 1; i < len; i++) if (src[i] == '\n') starts[k++] = i + 1;
  starts[nlines] = len + 1;  /* as if the last line ended with a '\n' */
  for (last = nlines; last > 0; last--) {  /* trailing blank lines are ignored */
    size_t a = starts[last - 1], e = starts[last] - 1;
    while (a < e && isspace((unsigned char)src[a])) a++;
    if (a < e) break;
  }
  kmin = (last > 20) ? last - 19 : 1;
  for (k = last; k > 1 && k >= kmin; k--, lua_settop(L, base)) {  /* (k = 1 is step 1 again) */
    size_t ps = starts[k - 1];  /* the offset of line k */
    size_t se = starts[last] - 1;  /* the end of the last line */
    luaL_Buffer b;
    /* (the suffix first: it is short, and fails at once on an "end") */
    s = lw_pushreturn(L, src + ps, se - ps, &slen);  /* at base + 1 */
    if (!lw_compiles(L, s, slen)) continue;
    if (!lw_compiles(L, src, ps - 1)) continue;
    if (orig) {
      /* (the prefix compiles, so line k starts between two tokens) */
      int same;
      luaL_buffinit(L, &b);
      luaL_addlstring(&b, src, ps);
      luaL_addchar(&b, ';');
      luaL_addlstring(&b, src + ps, len - ps);
      luaL_pushresult(&b);  /* at base + 2 */
      s = lua_tolstring(L, -1, &slen);
      if (luaL_loadbufferx(L, s, slen, name, "t") != LUA_OK) continue;
      lw_pushdump(L, -1);
      same = lua_rawequal(L, -1, top + 1);
      lua_settop(L, base + 1);
      if (!same) continue;
    }
    luaL_buffinit(L, &b);
    luaL_addlstring(&b, src, ps);  /* the prefix and its '\n' */
    lua_pushvalue(L, base + 1);
    luaL_addvalue(&b);
    luaL_pushresult(&b);
    s = lua_tolstring(L, -1, &slen);
    if (luaL_loadbufferx(L, s, slen, name, "t") == LUA_OK) {
      lua_replace(L, top + 1);  /* the function where the dump was */
      lua_settop(L, top + 1);
      lw_newrunner(L, 1, WK_CELL);
      return 1;
    }
  }
  lua_settop(L, top);
  return 0;
}

static int lw_cellprep (lua_State *L) {
  struct cellsrc *c = (struct cellsrc *)lua_touserdata(L, 1);
  const char *src = c->src, *chunk, *s;
  size_t len = c->len, slen;
  int status;
  chunk = lua_pushfstring(L, "=%s", cell_name);  /* at 2 */
  lw_clear_errtext(L);
  /* 1: an expression list */
  s = lw_pushreturn(L, src, len, &slen);  /* at 3 */
  if (luaL_loadbufferx(L, s, slen, chunk, "t") == LUA_OK) {
    lw_newrunner(L, 1, WK_CELL);
    return 0;
  }
  lua_settop(L, 2);
  status = luaL_loadbufferx(L, src, len, chunk, "t");  /* function or message at 3 */
  if (status == LUA_OK) {
    /* 2: a chunk whose last statement is an expression (a call): the
       split, which returns its values */
    if (lw_split(L, src, len, 2, 3)) return 0;
    /* 3: a chunk, whose values come from an explicit 'return' only */
    lw_newrunner(L, 1, WK_CELL);
    return 0;
  }
  /* 4: not a chunk: the split, whose last lines are an expression */
  if (lw_split(L, src, len, 2, 0)) return 0;
  /* 5 and 6: incomplete, or the chunk's own syntax error (at 3) */
  lua_settop(L, 3);
  {
    size_t ml;
    const char *msg = lw_errmsg(L, &ml);
    lw_done_error(lw_incomplete(L, status) ? "incomplete" : "error", "syntax",
                  msg, ml, msg, ml, 0);
  }
  return 0;
}

/* RID: 1..1073741823 in decimal; NAME: [A-Za-z0-9_.:[]-]{1,32} */
static int lw_parse_rid (const char *p, size_t len, size_t *used, long *rid) {
  size_t i;
  long v = 0;
  for (i = 0; i < len && i < 10 && isdigit((unsigned char)p[i]); i++)
    v = v * 10 + (p[i] - '0');
  if (i == 0 || v < 1 || v > 1073741823L) return 0;
  *used = i;
  *rid = v;
  return 1;
}

static int lw_namechar (int c) {
  return isalnum(c) || c == '_' || c == '.' || c == ':' || c == '[' || c == ']' || c == '-';
}

static void lw_cell_start (long rid, const char *name, size_t nlen, const char *src, size_t len) {
  struct cellsrc c;
  char tmp[128];
  int status;
  /* stdin is not dropped here but when the previous cell ended: input fed
     after a "run" was posted, before the cell started, is the cell's */
  cell_intr = intr ? 1 : 0;  /* a Stop sent for this queued cell */
  cell_rid = rid;
  memcpy(cell_name, name, nlen);
  cell_name[nlen] = '\0';
  cell_ms0 = lw_run_ms();
  jb_free(&done_jb);
  snprintf(tmp, sizeof(tmp), "{\"ev\":\"start\",\"rid\":%ld,\"name\":\"%s\"}", rid, cell_name);
  lw_event_lit(tmp);
  c.src = src;
  c.len = len;
  if ((status = lw_protect(lw_cellprep, &c)) != LUA_OK) lw_glue_fail(status);
  if (runner == NULL) {  /* it never runs: the result is known */
    lw_drop_input();
    lw_emit_done();
    cell_rid = 0;
    intr = 0;
  }
}

/* the kernel's next request; returns 0 when it goes IDLE */
static int lw_kernel_next (void) {
  struct req *r = req_head;
  const char *p;
  size_t len, used;
  long rid;
  if (r == NULL) {
    state = WEBREPL_IDLE;
    intr = 0;
    return 0;
  }
  if ((req_head = r->next) == NULL) req_tail = NULL;
  p = r->data;
  len = (size_t)r->len;
  if (len > 4 && memcmp(p, "run ", 4) == 0 && lw_parse_rid(p + 4, len - 4, &used, &rid)
      && 4 + used < len && p[4 + used] == ' ') {
    const char *name = p + 4 + used + 1;
    size_t rest = len - (4 + used + 1), nlen = 0;
    while (nlen < rest && nlen <= 32 && lw_namechar((unsigned char)name[nlen])) nlen++;
    if (nlen >= 1 && nlen <= 32 && (nlen == rest || name[nlen] == '\n')) {
      size_t skip = (nlen < rest) ? nlen + 1 : nlen;
      lw_cell_start(rid, name, nlen, name + skip, rest - skip);
      free(r);
      return 1;
    }
  }
  else if (len > 5 && memcmp(p, "ping ", 5) == 0 && lw_parse_rid(p + 5, len - 5, &used, &rid)
           && 5 + used == len) {
    char tmp[64];
    snprintf(tmp, sizeof(tmp), "{\"ev\":\"pong\",\"rid\":%ld}", rid);
    lw_event_lit(tmp);
    free(r);
    return 1;
  }
  {
    JBuf b = {NULL, 0, 0, 0};
    jb_lit(&b, "{\"ev\":\"bad-request\",\"text\":");
    jb_str(&b, p, len > 200 ? 200 : len);
    jb_lit(&b, "}");
    lw_event(&b, 0);
  }
  free(r);
  return 1;
}

/* }================================================================== */


/*
** {==================================================================
** Slices
** ===================================================================
*/

/* the runner ended with STATUS (not LUA_OK only if the glue's reporting failed) */
static void lw_finish (int status) {
  int w = work, st;
  if (status != LUA_OK) {
    size_t len;
    const char *msg = lw_errmsg(runner, &len);
    if (status == LUA_ERRMEM) { msg = "not enough memory"; len = strlen(msg); }
    lw_message(NULL, msg);
    if (w == WK_CELL)
      lw_done_error(cell_intr ? "interrupted" : "error",
                    cell_intr ? "interrupted" : lw_kind(status), msg, len, msg, len, 0);
    if (w == WK_JOB) job_failed = 1;
  }
  intr = 0;
  if ((st = lw_protect(lw_after, NULL)) != LUA_OK) {
    size_t len;
    lw_message(NULL, st == LUA_ERRMEM ? "not enough memory" : lw_errmsg(G, &len));
    lua_settop(G, 0);
  }
  runner = NULL;
  if (w == WK_CELL) {
    lw_drop_input();
    lw_emit_done();
    cell_rid = 0;
  }
  else if (w == WK_JOB) {
    if (job_failed && mode == MODE_REPL) lw_exit(EXIT_FAILURE, 1);
    if (mode == MODE_KERNEL && cur_job->kind == JOB_INIT && !job_failed) {
      jb_free(&init_jb);
      jb_lit(&init_jb, "{\"ev\":\"init\",\"status\":\"ok\"}");
    }
  }
}

/* resumes the runner; returns 0 when it yielded to the host (state set) */
static int lw_step (void) {
  int st, nres, n = rnargs;
  rnargs = 0;
  hy = HY_NONE;
  lw_arm(runner);
  st = lua_resume(runner, G, n, &nres);
  fflush(stdout);
  if (st == LUA_YIELD) {
    lua_pop(runner, nres);
    switch (hy) {
      case HY_SLICE: state = WEBREPL_BUSY; return 0;
      case HY_INPUT: state = WEBREPL_WAITING; prompt = 0; return 0;
      case HY_SLEEP: state = WEBREPL_SLEEPING; return 0;
      default:  /* impossible: coroutine.yield refuses the runner */
        lua_pushliteral(runner, "attempt to yield from outside a coroutine");
        st = LUA_ERRRUN;
    }
  }
  lw_finish(st);
  return 1;
}

static void lw_slice (void) {
  slice_t0 = lw_now();
  slice_end = slice_t0 + slice_ms;
  out_slice = 0;
  in_new = 0;
  in_slice = 1;
  state = WEBREPL_RUNNING;
  for (;;) {
    if (runner != NULL) {
      if (!lw_step()) break;
    }
    else if (!jobs_done && lw_nextjob()) continue;
    else if (!(mode == MODE_REPL ? lw_repl_next() : lw_kernel_next())) break;
    if (runner == NULL && lw_now() >= slice_end) {  /* between two chunks */
      state = WEBREPL_BUSY;
      break;
    }
  }
  if (state == WEBREPL_RUNNING) state = WEBREPL_BUSY;
  run_ms += lw_now() - slice_t0;
  in_slice = 0;
}

/* }================================================================== */


/*
** {==================================================================
** main and the API for JS (see web/repl-driver.js)
** ===================================================================
*/

int main (int argc, char **argv) {
  struct margs a;
  int script = 0, flags, status;
  /* stdout line buffered and stderr unbuffered, as on a tty; stdin keeps
     musl's full buffering (one JS call per buffer, not per byte) */
  setvbuf(stdout, NULL, _IOLBF, BUFSIZ);
  setvbuf(stderr, NULL, _IONBF, 0);
  lw_js_stdio();
  exited = 1;  /* until startup succeeds */
  exit_code = EXIT_FAILURE;
  flags = lw_collectargs(argv, &script);
  if (flags == has_error) {
    char tmp[300];
    const char *bad = argv[script];
    if (bad[1] == 'e' || bad[1] == 'l')
      snprintf(tmp, sizeof(tmp), "'%s' needs argument", bad);
    else
      snprintf(tmp, sizeof(tmp), "unrecognized option '%s'", bad);
    lw_usage(tmp);
    return EXIT_FAILURE;
  }
  if (script > 0 && strcmp(argv[script], "-") == 0 && strcmp(argv[script - 1], "--") != 0) {
    lw_usage("'-' (stdin script) is not supported here");
    return EXIT_FAILURE;
  }
  if (script > 0 && mode == MODE_KERNEL) {
    lw_usage("'--notebook' takes no script");
    return EXIT_FAILURE;
  }
  if ((G = luaL_newstate()) == NULL) {
    lw_message(LW_PROGNAME, "cannot create state: not enough memory");
    return EXIT_FAILURE;
  }
  memset(lua_getextraspace(G), 0, LUA_EXTRASPACE);  /* canfwd(G) = 0 */
  lua_atpanic(G, lw_panic);
  lua_gc(G, LUA_GCSTOP);  /* stop GC while building state */
  a.argc = argc;
  a.argv = argv;
  a.script = script;
  a.flags = flags;
  if ((status = lw_protect(lw_pmain, &a)) != LUA_OK) {
    size_t len;
    lw_message(LW_PROGNAME, status == LUA_ERRMEM ? "not enough memory" : lw_errmsg(G, &len));
    return EXIT_FAILURE;
  }
  if (!lw_queuejobs(argv, argc, script, flags))
    return EXIT_FAILURE;
  exited = 0;
  exit_code = 0;
  /* main runs no user code: only the warning controls up to the first
     job that needs a runner, which the first slice prepares */
  while (jobpos < njobs && (jobs[jobpos].kind == JOB_WARNOFF || jobs[jobpos].kind == JOB_WARNON))
    lua_warning(G, jobs[jobpos++].kind == JOB_WARNOFF ? "@off" : "@on", 0);
  started = 1;
  if (jobpos < njobs)
    state = WEBREPL_BUSY;
  else {
    lw_jobs_end();
    if (mode == MODE_KERNEL)
      state = WEBREPL_IDLE;
    else {
      lw_write_prompt(1);
      state = WEBREPL_WAITING;
    }
  }
  return 0;  /* with EXIT_RUNTIME=0 the instance stays alive */
}


/*
** P is LEN bytes (NULs allowed).  Outside a slice the consumed prefix is
** compacted away first; inside one (a JS callback reached from Lua) the
** bytes are only appended, as C keeps offsets into in_buf, never
** pointers, across anything that can reach JS.
*/
EMSCRIPTEN_KEEPALIVE void webrepl_feed (const char *p, int len, int eof) {
  if (exited) return;
  if (len > 0) {
    size_t need;
    if (!in_slice && in_pos > 0) {
      memmove(in_buf, in_buf + in_pos, in_len - in_pos);
      in_len -= in_pos;
      in_pos = 0;
    }
    need = in_len + (size_t)len;
    if (need > in_cap) {
      size_t ncap = in_cap ? in_cap : 4096;
      char *np;
      while (ncap < need) ncap *= 2;
      if ((np = realloc(in_buf, ncap)) == NULL) return;  /* dropped */
      in_buf = np;
      in_cap = ncap;
    }
    memcpy(in_buf + in_len, p, (size_t)len);
    in_len += (size_t)len;
    in_new = 1;
  }
  if (eof) in_eof = in_new = 1;
}

/* a whole kernel request, copied onto the tail of the mailbox */
EMSCRIPTEN_KEEPALIVE void webrepl_post (const char *p, int len) {
  struct req *r;
  if (exited || mode != MODE_KERNEL || len < 0) return;
  if ((r = malloc(sizeof(*r) + (size_t)len)) == NULL) return;
  r->next = NULL;
  r->len = len;
  memcpy(r->data, p, (size_t)len);
  if (req_tail != NULL) req_tail->next = r; else req_head = r;
  req_tail = r;
}

EMSCRIPTEN_KEEPALIVE int webrepl_resume (void) {
  int run = 0;
  if (in_slice || !started || exited) return state;
  switch (state) {
    case WEBREPL_BUSY:
      run = 1;
      break;
    case WEBREPL_SLEEPING:
      run = (lw_now() >= wake_at || intr);
      break;
    case WEBREPL_WAITING:
      if (prompt != WEBREPL_NOPROMPT)  /* at a REPL prompt */
        run = (lw_line_ready() || in_eof || intr);
      else  /* a reader: its continuation checks what it needs again */
        run = (in_new || in_eof || intr);
      break;
    case WEBREPL_IDLE:
      run = (req_head != NULL);
      break;
  }
  if (run) lw_slice();
  return state;
}

/*
** Stop.  An idle kernel has nothing to stop unless a request is queued
** (Run, then Stop before the worker pumped).  At a REPL prompt only an
** unfinished statement is stopped (dropped).  Otherwise 'intr' makes the
** next hook, read or sleep raise "interrupted!".
*/
EMSCRIPTEN_KEEPALIVE void webrepl_interrupt (void) {
  if (!started || exited) return;
  if (state == WEBREPL_IDLE && req_head == NULL) return;
  if (state == WEBREPL_WAITING && prompt != WEBREPL_NOPROMPT) {
    if (ml_pending) intr = 1;
    return;
  }
  intr = 1;
  if (mode == MODE_KERNEL && (cell_rid != 0 || req_head != NULL)) cell_intr = 1;
}

EMSCRIPTEN_KEEPALIVE void webrepl_note_output (int n) {
  if (!in_slice || n <= 0) return;
  out_slice += (size_t)n;
  if (out_slice > 65536) slice_end = 0;  /* the next hook that can yield does */
}

/* called by the fd 2 write op (above) before each write to stderr */
EMSCRIPTEN_KEEPALIVE void webrepl_flush_stdout (void) {
  fflush(stdout);
}

EMSCRIPTEN_KEEPALIVE int webrepl_stdin_read (unsigned char *buf, int max) {
  size_t avail = in_len - in_pos, n;
  if (avail == 0) return in_eof ? 0 : -1;
  if (max <= 0) return 0;
  n = avail < (size_t)max ? avail : (size_t)max;
  memcpy(buf, in_buf + in_pos, n);
  in_pos += n;
  if (in_pos == in_len) in_pos = in_len = 0;
  return (int)n;
}

EMSCRIPTEN_KEEPALIVE int webrepl_state (void) { return state; }
EMSCRIPTEN_KEEPALIVE int webrepl_prompt (void) {
  return (mode == MODE_REPL && state == WEBREPL_WAITING) ? prompt : WEBREPL_NOPROMPT;
}
EMSCRIPTEN_KEEPALIVE int webrepl_started (void) { return started; }
EMSCRIPTEN_KEEPALIVE int webrepl_exited (void) { return exited; }
EMSCRIPTEN_KEEPALIVE int webrepl_exit_code (void) { return exit_code; }

/*
** At most 50 ms, as chicken's sleep: the driver's timer for the wake-up
** is pending meanwhile, and a Stop is acted on only at the next resume.
** Waking early just finds SLEEPING not yet due.
*/
#define WAKEUP_MAX	50.0

EMSCRIPTEN_KEEPALIVE double webrepl_wakeup_ms (void) {
  double ms;
  if (state != WEBREPL_SLEEPING) return 0;
  ms = wake_at - lw_now();
  return ms < 1 ? 1 : ms > WAKEUP_MAX ? WAKEUP_MAX : ms;
}

EMSCRIPTEN_KEEPALIVE void webrepl_set_slice_ms (double ms) {
  slice_ms = !(ms >= 1) ? 1 : ms > 10000 ? 10000 : ms;
}

/* }================================================================== */

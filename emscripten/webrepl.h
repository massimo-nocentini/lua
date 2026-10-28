/*
** $Id: webrepl.h $
** C interface of the Lua console and notebook kernel (WebAssembly)
** See Copyright Notice in lua.h
*/

#ifndef webrepl_h
#define webrepl_h

/*
** The web module (lua-repl.js, built from webrepl-main.c) is driven from
** JavaScript (web/repl-driver.js) through the functions below, which it
** exports.  JS never re-enters Lua while a slice runs: it calls
** webrepl_resume() again whenever the state says there is more to do.
** The state numbers are part of the protocol: JS hard-codes them.
*/

/* states, as returned by webrepl_state() and webrepl_resume() */
enum {
  WEBREPL_RUNNING = 0,   /* inside a slice (never seen by JS between calls) */
  WEBREPL_WAITING = 1,   /* the REPL waits for a line, or Lua code reads stdin */
  WEBREPL_BUSY = 2,      /* slice expired, more work: resume soon */
  WEBREPL_EXITED = 3,    /* os.exit, EOF at the prompt, a failed startup job */
  WEBREPL_SLEEPING = 4,  /* notebook.sleep: resume after webrepl_wakeup_ms() */
  WEBREPL_IDLE = 5       /* notebook kernel waits for a request (never the REPL) */
};

/* prompt levels, as returned by webrepl_prompt() */
enum { WEBREPL_NOPROMPT = 0, WEBREPL_PROMPT1 = 1, WEBREPL_PROMPT2 = 2 };


/*
** Pointers: on wasm64 the link's -sSIGNATURE_CONVERSIONS lets JS pass the
** pointer arguments of webrepl_feed, webrepl_post and webrepl_stdin_read
** as Numbers, as _malloc and stringToNewUTF8 return them.
*/

/* append LEN bytes (NULs allowed) to the stdin queue; EOF ends a read */
void webrepl_feed (const char *p, int len, int eof);
/* one whole notebook kernel request, copied (JS may free P at once) */
void webrepl_post (const char *p, int len);
/* run one slice if there is work; returns the new state */
int webrepl_resume (void);
/* Stop: interrupt the running chunk or cell (see webrepl-main.c) */
void webrepl_interrupt (void);

int webrepl_state (void);
int webrepl_prompt (void);
int webrepl_started (void);
int webrepl_exited (void);
int webrepl_exit_code (void);
/* in SLEEPING, the milliseconds left until the wake-up (at least 1) */
double webrepl_wakeup_ms (void);
/* the time slice, clamped to 1..10000 ms (default 50) */
void webrepl_set_slice_ms (double ms);

/*
** Called only by the module's own stream ops (the EM_JS in
** webrepl-main.c), never by the page: the fd 0 read op takes queued
** stdin bytes (returns their number, 0 for EOF, -1 when none is
** available yet), the fd 1/2 write ops report each write's length,
** which bounds the output of one slice, and the fd 2 op flushes stdout.
*/
int webrepl_stdin_read (unsigned char *buf, int max);
void webrepl_note_output (int n);
/* the fd 2 write op flushes C's stdout first, so that order is kept */
void webrepl_flush_stdout (void);

#endif

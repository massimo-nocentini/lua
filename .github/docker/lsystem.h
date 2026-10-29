/*
** lsystem.h - os.execute's system() with errno cleared on success
** Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
**
** Included by lua.h through LUA_USER_H (see .github/docker/Dockerfile).
** os_execute sets errno to 0, calls l_system and hands its status to
** luaL_execresult, which reports a nonzero status with a nonzero errno
** as a failure of system() itself.  But errno is unspecified after a
** call that succeeds, and glibc's system() leaves it at ENOSYS when a
** seccomp profile (Docker's, BuildKit's) refuses clone3 and it falls
** back to clone: os.execute("exit 3") would return nil, "Function not
** implemented", 38.  system() fails only by returning -1.
*/

#ifndef lsystem_h
#define lsystem_h

#include <errno.h>
#include <stdlib.h>

static inline int l_system_errno (const char *cmd) {
  int stat = system(cmd);
  if (stat != -1)
    errno = 0;
  return stat;
}

#define l_system(cmd)	l_system_errno(cmd)

#endif

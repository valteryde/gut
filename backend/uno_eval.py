#!/usr/bin/env python3
"""UNO bridge for the Gut agent — runs Python-UNO against the LIVE
LibreOffice process (the visible document, not a headless copy).

Runs under the SYSTEM python (/usr/bin/python3): the `uno` module arrives
via apt (python3-uno), not the daemon venv. The snippet arrives on stdin
and executes with these globals:

  uno          the uno module
  ctx          the remote component context
  smgr         the service manager
  desktop      com.sun.star.frame.Desktop
  doc          the current document component (None when nothing is open)
  load(path)   open a document by filesystem path (returns the component)
  file_url(p)  path -> file:// URL
  result       if set, repr(result) is printed after the snippet's stdout

If LibreOffice isn't running it is started with the UNO listener. If it IS
running but has no listener (launched without --accept — the gut wrapper at
/usr/local/bin/soffice adds one automatically), the snippet can't run and
we say so.
"""

import os
import subprocess
import sys
import time

PORT = os.environ.get("GUT_UNO_PORT", "2002")
ACCEPT = f"socket,host=127.0.0.1,port={PORT};urp;"


def connect():
    import uno
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local)
    return uno, resolver.resolve(
        "uno:socket,host=127.0.0.1,port=" + PORT
        + ";urp;StarOffice.ComponentContext")


def soffice_running():
    return subprocess.run(["pgrep", "-x", "soffice.bin"],
                          capture_output=True).returncode == 0


try:
    uno, ctx = connect()
except Exception:
    if soffice_running():
        sys.exit("LibreOffice is running but has no UNO listener — it was "
                 "launched without --accept. Close it and relaunch via the "
                 "desktop icon or `soffice` (the gut wrapper adds the "
                 "listener automatically).")
    try:
        subprocess.Popen(["/usr/bin/soffice", f"--accept={ACCEPT}",
                          "--norestore", "--nologo", "--nodefault"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    except OSError as e:
        sys.exit(f"cannot launch LibreOffice ({e}) — is it installed?")
    uno = ctx = None
    for _ in range(100):  # cold start can take ~10-30s
        time.sleep(0.3)
        try:
            uno, ctx = connect()
            break
        except Exception:
            continue
    if ctx is None:
        sys.exit("LibreOffice would not come up with the UNO listener")

smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)


def file_url(path):
    return uno.systemPathToFileUrl(os.path.abspath(os.path.expanduser(path)))


def load(path, hidden=False):
    props = ()
    if hidden:
        p = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
        p.Name, p.Value = "Hidden", True
        props = (p,)
    return desktop.loadComponentFromURL(file_url(path), "_blank", 0, props)


g = {"uno": uno, "ctx": ctx, "smgr": smgr, "desktop": desktop,
     "doc": desktop.getCurrentComponent(), "load": load,
     "file_url": file_url, "result": None}
try:
    exec(compile(sys.stdin.read(), "<office_eval>", "exec"), g)
except Exception as e:
    print(f"office_eval error: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
if g.get("result") is not None:
    print(repr(g["result"]))

#!/usr/bin/env python3
"""AT-SPI bridge for the Gut agent — the native-app analogue of browser_dom.

Runs under the SYSTEM python (/usr/bin/python3): pyatspi arrives via apt
(python3-pyatspi), not the daemon venv. Needs the session a11y bus —
start.sh launches at-spi-bus-launcher inside the desktop session.

Commands:
  apps                     list application names on the desktop
  tree [name-substring]    dump the focused (or named) app's accessible tree
                           as numbered #refs; ends with '@@map {ref: path}'
  act <path> [action]      perform an action (press/activate/...) on a node
  bounds <path>            print "x y w h cx cy" screen bounds
  settext <path> <text>    replace an editable text node's contents
  focus <path>             grab keyboard focus

A <path> is "app-name|i0,i1,..." — child indexes from the application root,
emitted by `tree`. Paths go stale when the UI changes; re-dump on failure.
"""

import json
import sys

try:
    import pyatspi
except ImportError:
    sys.exit("pyatspi is not installed (apt: python3-pyatspi)")

MAX_NODES = 300
MAX_DEPTH = 14


def _err(msg):
    print(f"error: {msg}")
    sys.exit(2)


def _apps():
    try:
        desk = pyatspi.Registry.getDesktop(0)
        return [desk.getChildAtIndex(i) for i in range(desk.childCount)]
    except Exception as e:
        _err(f"cannot reach the AT-SPI bus ({e}) — is at-spi2-core running?")


def _state(node, name):
    try:
        return node.getState().contains(getattr(pyatspi, name))
    except Exception:
        return False


def _resolve(path):
    app_name, _, idxs = path.partition("|")
    app = None
    for a in _apps():
        try:
            if (a.name or "") == app_name:
                app = a
                break
        except Exception:
            continue
    if app is None:
        _err(f"app '{app_name}' is gone — run tree again for fresh refs")
    node = app
    try:
        for i in idxs.split(","):
            node = node.getChildAtIndex(int(i))
        node.getRoleName()  # force a round-trip: dead nodes fail here
    except Exception:
        _err("node is stale — the UI changed; run tree again for fresh refs")
    return node


def _app_name(a):
    try:
        return a.name or ""
    except Exception:
        return ""


def _pick_app(sub):
    apps = [a for a in _apps()
            if _app_name(a) not in ("", "at-spi2-registryd")]
    if sub:
        low = sub.lower()
        for a in apps:
            if low in _app_name(a).lower():
                return a
        _err(f"no app matching '{sub}' — apps: "
             + ", ".join(_app_name(a) or "?" for a in apps))
    # the app whose window currently holds focus
    for a in apps:
        for i in range(a.childCount):
            try:
                if _state(a.getChildAtIndex(i), "STATE_ACTIVE"):
                    return a
            except Exception:
                continue
    if not apps:
        _err("no accessible applications — is the a11y bus up?")
    return apps[0]


def _actions(node):
    try:
        act = node.queryAction()
        return [act.getName(i) for i in range(act.nActions)]
    except Exception:
        return []


def _extents(node):
    try:
        r = node.queryComponent().getExtents(pyatspi.XY_SCREEN)
        try:
            return int(r.x), int(r.y), int(r.width), int(r.height)
        except AttributeError:
            return int(r[0]), int(r[1]), int(r[2]), int(r[3])
    except Exception:
        return 0, 0, 0, 0


def cmd_apps():
    for a in _apps():
        try:
            print(f"{a.name} ({a.childCount} toplevel)")
        except Exception:
            continue


def cmd_tree(sub):
    app = _pick_app(sub)
    aname = _app_name(app)
    refs, lines, count = {}, [f"# app: {aname}"], [0]

    def walk(node, path, depth):
        if count[0] >= MAX_NODES or depth > MAX_DEPTH:
            return
        try:
            role = node.getRoleName()
            name = (node.name or "").strip().replace("\n", " ")
            showing = _state(node, "STATE_SHOWING")
        except Exception:
            return
        if not showing:
            return  # hidden subtree — closed menu, minimized window
        acts = _actions(node)
        # Only name-bearing or actionable nodes earn a line; unnamed panels
        # and document paragraphs would drown the dump otherwise.
        emit = bool(acts) or _state(node, "STATE_EDITABLE") \
            or (bool(name) and role != "paragraph")
        if emit:
            count[0] += 1
            ref = count[0]
            refs[str(ref)] = path
            x, y, w, h = _extents(node)
            line = f"{'  ' * (depth - 1)}#{ref} {role}"
            if name:
                line += f' "{name[:60]}"'
            if acts:
                line += f" [{','.join(acts[:4])}]"
            if w or h:
                line += f" @{x},{y} {w}x{h}"
            lines.append(line)
        for i in range(node.childCount):
            try:
                walk(node.getChildAtIndex(i), f"{path},{i}", depth + 1)
            except Exception:
                continue

    for i in range(app.childCount):
        try:
            child = app.getChildAtIndex(i)
        except Exception:
            continue
        walk(child, f"{aname}|{i}", 1)
    if count[0] >= MAX_NODES:
        lines.append(f"(truncated at {MAX_NODES} refs — pass an app name to "
                     "tree for a narrower dump)")
    lines.append("@@map " + json.dumps(refs))
    print("\n".join(lines))


def cmd_act(path, action):
    node = _resolve(path)
    try:
        act = node.queryAction()
        names = [act.getName(i) for i in range(act.nActions)]
    except Exception:
        names = []
    if not names:
        _err("node has no actions — try desktop_click on its bounds")
    if action:
        low = action.lower()
        idx = next((i for i, n in enumerate(names) if n.lower() == low),
                   None)
        if idx is None:
            idx = next((i for i, n in enumerate(names) if low in n.lower()),
                       None)
        if idx is None:
            _err(f"no action '{action}' — available: {', '.join(names)}")
    else:
        idx = 0
        for pref in ("press", "activate", "click", "select", "toggle"):
            hits = [i for i, n in enumerate(names) if n.lower() == pref]
            if hits:
                idx = hits[0]
                break
    ok = act.doAction(idx)
    try:
        desc = f"{node.getRoleName()} \"{(node.name or '')[:40]}\""
    except Exception:
        desc = "node"
    print(f"{'did' if ok else 'action returned false for'} "
          f"'{names[idx]}' on {desc}")


def cmd_bounds(path):
    x, y, w, h = _extents(_resolve(path))
    print(f"{x} {y} {w} {h} {x + w // 2} {y + h // 2}")


def cmd_settext(path, text):
    node = _resolve(path)
    try:
        node.queryEditableText().setTextContents(text)
    except Exception as e:
        _err(f"node is not editable ({e})")
    print(f"set text on {node.getRoleName()} \"{(node.name or '')[:40]}\"")


def cmd_focus(path):
    node = _resolve(path)
    try:
        ok = node.queryComponent().grabFocus()
    except Exception as e:
        _err(f"cannot focus node ({e})")
    print(f"{'focused' if ok else 'focus returned false for'} "
          f"{node.getRoleName()} \"{(node.name or '')[:40]}\"")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "apps":
        cmd_apps()
    elif cmd == "tree":
        cmd_tree(sys.argv[2] if len(sys.argv) > 2 else "")
    elif cmd == "act" and len(sys.argv) > 2:
        cmd_act(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
    elif cmd == "bounds" and len(sys.argv) > 2:
        cmd_bounds(sys.argv[2])
    elif cmd == "settext" and len(sys.argv) > 3:
        cmd_settext(sys.argv[2], sys.argv[3])
    elif cmd == "focus" and len(sys.argv) > 2:
        cmd_focus(sys.argv[2])
    else:
        sys.exit(__doc__.strip())

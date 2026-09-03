#!/usr/bin/env python
"""Arm, disarm and inspect the context-budget / rolling-handoff loop.

The loop is opt-in. Disarmed, both hooks exit silently and nothing about a
session changes. Armed, the PostToolUse guard forces a handoff at its
thresholds and the SessionStart hook re-injects that handoff after a /clear.

    python .claude/hooks/autohandoff.py on [note]
    python .claude/hooks/autohandoff.py off
    python .claude/hooks/autohandoff.py status

The armed marker is a file, deliberately: it has to outlive the session that
set it, or the loop would disarm itself at the first /clear - exactly when it
is needed most.
"""
import json
import os
import sys
import time

ARM_TTL_DAYS = 7


def project_dir():
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def paths(root):
    return (
        os.path.join(root, ".claude", "state", "guard-armed.json"),
        os.path.join(root, ".claude", "context-budget.json"),
    )


def load_config(root):
    _, cfg_path = paths(root)
    try:
        with open(cfg_path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def armed_state(root):
    """(is_armed, reason) - shared by both hooks and the status command.

    "always" in the config opts the whole project in permanently; otherwise an
    arm marker is required, and one left behind for ARM_TTL_DAYS expires rather
    than quietly guarding unrelated work weeks later.
    """
    cfg = load_config(root)
    if not cfg.get("enabled", True):
        return False, "disabled in .claude/context-budget.json"
    mode = cfg.get("mode", "manual")
    if mode == "always":
        return True, "mode=always"
    if mode == "off":
        return False, "mode=off"

    arm_path, _ = paths(root)
    try:
        with open(arm_path, "r", encoding="utf-8") as fh:
            rec = json.load(fh)
    except Exception:
        return False, "not armed"

    age = (time.time() - float(rec.get("armed_at", 0))) / 86400.0
    if age > ARM_TTL_DAYS:
        return False, "arm marker expired (%d days old) - run /autohandoff on to re-arm" % age
    note = rec.get("note") or ""
    return True, "armed %.1fh ago%s" % (age * 24, " for: " + note if note else "")


def cmd_on(root, note):
    arm_path, _ = paths(root)
    os.makedirs(os.path.dirname(arm_path), exist_ok=True)
    with open(arm_path, "w", encoding="utf-8") as fh:
        json.dump({"armed_at": time.time(), "note": note}, fh)
    cfg = load_config(root)
    thresholds = cfg.get("thresholds", [50, 70, 85])
    rel = cfg.get("handoffPath", "docs/audits/handoffs/HANDOFF-ACTIVE.md")
    hands_free = cfg.get("atThreshold", "stop") == "continue"
    print("Auto-handoff ARMED%s." % (" for: " + note if note else ""))
    print("  From here it runs itself. Just work.")
    print("")
    if hands_free:
        print("  Mode: continue (hands-free). At %s%% of the context window this session" % thresholds[0])
        print("  saves %s, commits it, and keeps going." % rel)
        print("  Auto-compact reclaims the window on its own; the handoff is re-injected")
        print("  afterwards. You do nothing at all.")
    else:
        print("  Mode: stop (cleanest context). At %s%% of the context window this session" % thresholds[0])
        print("  stops, writes %s, and commits it." % rel)
        print("  It then prints:  HANDOFF READY - run /clear, then send any message")
        print("")
        print("  You type /clear and then any single word. The next session loads that")
        print("  handoff by itself and carries on - you never paste anything.")
        print("  For zero keystrokes instead, set atThreshold to continue in")
        print("  .claude/context-budget.json.")
    print("")
    print("  Later thresholds: %s%%. Expires after %d days if left armed."
          % (", ".join(str(t) for t in thresholds[1:]) or "none", ARM_TTL_DAYS))
    print("  Disarm with /autohandoff off when the work lands.")


def cmd_off(root):
    arm_path, _ = paths(root)
    try:
        os.remove(arm_path)
        print("Auto-handoff DISARMED. Hooks are inert; sessions behave normally.")
    except FileNotFoundError:
        print("Auto-handoff was not armed. Nothing to do.")


def cmd_status(root):
    ok, reason = armed_state(root)
    cfg = load_config(root)
    print("Auto-handoff: %s (%s)" % ("ARMED" if ok else "off", reason))
    print("  mode:       %s" % cfg.get("mode", "manual"))
    print("  at 50%%:      %s" % ("save a checkpoint and keep working (hands-free)"
                                  if cfg.get("atThreshold", "stop") == "continue"
                                  else "stop and wait for /clear"))
    print("  thresholds: %s" % cfg.get("thresholds", [50, 70, 85]))

    rel = cfg.get("handoffPath", "docs/audits/handoffs/HANDOFF-ACTIVE.md")
    hp = os.path.join(root, rel.replace("/", os.sep))
    if os.path.exists(hp):
        age_h = (time.time() - os.path.getmtime(hp)) / 3600.0
        print("  handoff:    %s (updated %.1fh ago)" % (rel, age_h))
    else:
        print("  handoff:    none - %s does not exist" % rel)

    pct_path = os.path.join(root, ".claude", "state", "context-pct.json")
    try:
        with open(pct_path, "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        fresh = time.time() - float(rec.get("ts", 0)) < 180
        print("  context:    %s%%%s" % (rec.get("pct"), "" if fresh else " (stale reading)"))
    except Exception:
        print("  context:    unknown (statusline has not published a reading yet)")


def main(argv):
    root = project_dir()
    cmd = (argv[0] if argv else "status").lower().lstrip("-")
    if cmd in ("on", "arm", "start", "enable"):
        cmd_on(root, " ".join(argv[1:]).strip())
    elif cmd in ("off", "disarm", "stop", "disable"):
        cmd_off(root)
    elif cmd in ("status", "state", ""):
        cmd_status(root)
    else:
        print("usage: autohandoff.py [on [note] | off | status]")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

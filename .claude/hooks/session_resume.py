#!/usr/bin/env python
"""SessionStart hook: re-seed a fresh session from the active rolling handoff.

After /clear (or a crash, a compact, or a plain restart) this puts the live
handoff back in front of the agent, so the implementation continues instead of
starting over. Silent when there is no active handoff.
"""
import json
import os
import sys
import time

HANDOFF = "docs/audits/handoffs/HANDOFF-ACTIVE.md"
MAX_CHARS = 60_000
STATE_TTL_DAYS = 7


def is_armed(project_dir):
    """The loop is opt-in; see .claude/hooks/autohandoff.py for the switch."""
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.join(project_dir, ".claude", "hooks"))
    try:
        from autohandoff import armed_state

        return armed_state(project_dir)[0]
    except Exception:
        return False


def load_config(project_dir):
    path = os.path.join(project_dir, ".claude", "context-budget.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def prune_state(project_dir):
    d = os.path.join(project_dir, ".claude", "state")
    cutoff = time.time() - STATE_TTL_DAYS * 86400
    try:
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if name.startswith("context-guard-") and os.path.getmtime(p) < cutoff:
                os.remove(p)
    except Exception:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    if (payload.get("agent_type") or "main") not in ("main", "root"):
        return 0

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    if not is_armed(project_dir):
        return 0
    prune_state(project_dir)

    cfg = load_config(project_dir)
    rel = cfg.get("handoffPath", HANDOFF)
    path = os.path.join(project_dir, rel.replace("/", os.sep))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            body = fh.read()
    except Exception:
        return 0

    if not body.strip():
        return 0
    # A handoff whose work is finished is archived, not deleted in place; until
    # then an explicit marker keeps it from re-seeding sessions.
    head = body[:400].lower()
    if "status: consumed" in head or "status: archived" in head:
        return 0

    age_days = (time.time() - os.path.getmtime(path)) / 86400.0
    stale = ""
    if age_days > 3:
        stale = (
            "\n!! This handoff has not been touched in %d days. It may belong to finished\n"
            "   work that was never closed out. Check it against git log before trusting it;\n"
            "   if the slice is done, rename it to HANDOFF-<issue>-<date>.md and start clean.\n"
        ) % int(age_days)

    truncated = len(body) > MAX_CHARS
    if truncated:
        body = body[:MAX_CHARS] + "\n\n[handoff truncated at %d chars - read %s for the rest]\n" % (
            MAX_CHARS,
            rel,
        )

    how = payload.get("how") or payload.get("source") or "startup"
    context = (
        "ACTIVE HANDOFF - this session is a continuation, not a fresh start ({0}).\n"
        "\n"
        "The previous session hit its context budget and handed off. Everything below was\n"
        "written by it, on disk at {1}. Treat it as the brief.\n"
        "\n"
        "How to use it:\n"
        "  - START WORKING. The user's first message is a go-ahead, not a brief - it may be a\n"
        "    single word. Do not ask what to do next, do not ask them to confirm the plan, and\n"
        "    do not summarise this handoff back at them. Read what it points at, then execute\n"
        "    its 'Next step'. If their message asks for something else, that wins.\n"
        "  - Do not re-explore ground it already covers or redesign decisions it recorded.\n"
        "    Its 'Standing instructions from the user' are still in force - treat them as if\n"
        "    the user had just said them.\n"
        "  - Keep this file current as you work - refresh it after every green test run, not\n"
        "    just when a threshold fires. It is the only thing that survives a /clear.\n"
        "  - When the slice is genuinely done: rename it to HANDOFF-<issue>-<date>.md in the\n"
        "    same folder so it stops seeding sessions and stays as the audit trail, and run\n"
        "    /autohandoff off.\n"
        "{3}"
        "\n"
        "----- BEGIN {1} -----\n"
        "{2}\n"
        "----- END {1} -----"
    ).format(how, rel, body, stale)

    first = ""
    for line in body.splitlines():
        if line.strip():
            first = line.strip().lstrip("# ").strip()
            break

    json.dump(
        {
            "systemMessage": "Resuming from %s%s%s - %s"
            % (rel, " (truncated)" if truncated else "",
               " [STALE %dd]" % age_days if stale else "", first[:100]),
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context,
            },
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

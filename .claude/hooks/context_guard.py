#!/usr/bin/env python
"""PostToolUse hook: watch the real context usage and force a handoff at a threshold.

Reads the session transcript, takes the token accounting from the most recent
assistant message (input + cache_read + cache_creation == the true prompt size of
that request), and when it crosses a configured percentage of the model's context
window it injects a stop-and-hand-off instruction into the conversation.

Fires once per threshold per session; state lives in .claude/state/.
Configuration: .claude/context-budget.json (see load_config).
"""
import json
import os
import sys
import time

HANDOFF = "docs/audits/handoffs/HANDOFF-ACTIVE.md"
TAIL_BYTES = 400_000

DEFAULTS = {
    "thresholds": [50, 70, 85],
    "contextLimit": None,          # null => infer from the model id
    "handoffPath": HANDOFF,
    "enabled": True,
}


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
    cfg = dict(DEFAULTS)
    path = os.path.join(project_dir, ".claude", "context-budget.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    except Exception:
        pass
    env = os.environ.get("FSM_CONTEXT_THRESHOLD")
    if env:
        try:
            cfg["thresholds"] = [int(x) for x in env.split(",") if x.strip()]
        except ValueError:
            pass
    return cfg


def infer_limit(model_id):
    """Context window in tokens.

    The transcript records the base model id with the variant suffix stripped
    (`claude-opus-5`, never `claude-opus-5[1m]`), so the 1M window is invisible
    there. Fall back to the configured model id in the user's settings.
    """
    hints = [(model_id or "").lower()]
    try:
        with open(os.path.expanduser("~/.claude/settings.json"), "r", encoding="utf-8") as fh:
            hints.append(str(json.load(fh).get("model", "")).lower())
    except Exception:
        pass
    if any("1m" in h for h in hints):
        return 1_000_000
    return 200_000


def published_pct(project_dir, session_id, max_age=180):
    """The percentage Claude Code itself reported, mirrored by the statusline.

    Exact where it is available - it uses Claude Code's own accounting rather
    than re-deriving it - but only trusted while fresh and for this session.
    """
    path = os.path.join(project_dir, ".claude", "state", "context-pct.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            rec = json.load(fh)
        if session_id and rec.get("session_id") not in (None, "", session_id):
            return None
        if time.time() - float(rec.get("ts", 0)) > max_age:
            return None
        return int(rec["pct"])
    except Exception:
        return None


def last_usage(transcript_path):
    """(used_tokens, model_id) from the newest assistant message, or (None, None)."""
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as fh:
            if size > TAIL_BYTES:
                fh.seek(size - TAIL_BYTES)
                fh.readline()          # discard the partial first line
            lines = fh.read().decode("utf-8", "replace").splitlines()
    except Exception:
        return None, None

    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        msg = rec.get("message") or {}
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            continue
        used = (
            (usage.get("input_tokens") or 0)
            + (usage.get("cache_read_input_tokens") or 0)
            + (usage.get("cache_creation_input_tokens") or 0)
        )
        if used > 0:
            return used, msg.get("model")
    return None, None


def state_file(project_dir, session_id):
    d = os.path.join(project_dir, ".claude", "state")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "context-guard-%s.json" % (session_id or "unknown"))


def directive(pct, used, limit, handoff_path, final):
    urgency = "LAST CALL" if final else "CONTEXT BUDGET"
    tail = (
        "This is the highest threshold. Do not start anything else; hand off now."
        if final
        else "Finishing the current red-green step first is fine. Starting a new one is not."
    )
    return (
        "[{0}] {1}% of the context window is in use ({2:,} / {3:,} tokens).\n"
        "\n"
        "Stop taking on new work and hand off, in this order:\n"
        "  1. Bring the tree to a coherent state - finish or revert the in-flight edit.\n"
        "     Never hand off mid-edit with a file half-rewritten.\n"
        "  2. Run the tests that cover what you touched. Record pass/fail verbatim;\n"
        "     a failing test is handoff content, not a reason to keep grinding.\n"
        "  3. Rewrite {4} from scratch using\n"
        "     docs/audits/handoffs/HANDOFF-TEMPLATE.md, filling in EVERY section. It must\n"
        "     stand alone: the next session starts with zero memory of this conversation and\n"
        "     sees only that file. Scroll back through the whole session before you write -\n"
        "     in particular for corrections and constraints the user gave you, which go under\n"
        "     'Standing instructions from the user' quoted, not paraphrased. Record decisions,\n"
        "     dead ends and gotchas that are NOT recoverable from the diff. Do not re-summarise\n"
        "     what the issue file, the diff or the commits already say - reference them by path.\n"
        "  4. Commit everything, including the handoff (a WIP commit is correct here).\n"
        "  5. Append the session-log line to .scratch/fsm-platform-v1/INDEX.md and update the\n"
        "     status of every issue you touched.\n"
        "  6. Then print exactly this line and stop:\n"
        "     HANDOFF READY - run /clear, then send any message (e.g. go)\n"
        "\n"
        "{5}\n"
        "The user pastes nothing: the SessionStart hook loads that handoff into the next\n"
        "session by itself, so their first message can be a single word. That only works if\n"
        "the file is complete, so spend the tokens on it - it is the last thing this session\n"
        "does and the only thing that survives it."
    ).format(urgency, pct, used, limit, handoff_path, tail)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    # Subagents have their own windows and their own transcripts - ignore them.
    if (payload.get("agent_type") or "main") not in ("main", "root"):
        return 0

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    if not is_armed(project_dir):
        return 0
    cfg = load_config(project_dir)

    session_id = payload.get("session_id")

    # Fast path: the statusline publishes Claude Code's own accounting, so the
    # transcript (megabytes, re-read on every tool call) is only touched when that
    # is missing or stale.
    pct = published_pct(project_dir, session_id)
    if pct is not None:
        limit = cfg.get("contextLimit") or infer_limit(None)
        used = int(pct * limit / 100)
    else:
        used, model_id = last_usage(payload.get("transcript_path") or "")
        if not used:
            return 0
        limit = cfg.get("contextLimit") or infer_limit(model_id)
        pct = int(used * 100 / limit)

    crossed = [t for t in sorted(cfg["thresholds"]) if pct >= t]
    if not crossed:
        return 0
    highest = crossed[-1]

    sf = state_file(project_dir, session_id)
    try:
        with open(sf, "r", encoding="utf-8") as fh:
            fired = json.load(fh).get("fired", 0)
    except Exception:
        fired = 0
    if highest <= fired:
        return 0
    try:
        with open(sf, "w", encoding="utf-8") as fh:
            json.dump({"fired": highest, "pct": pct, "used": used, "limit": limit}, fh)
    except Exception:
        pass

    is_final = highest == max(cfg["thresholds"])
    text = directive(pct, used, limit, cfg["handoffPath"], is_final)
    json.dump(
        {
            "systemMessage": "Context %d%% (%s/%s) - handoff threshold %d%% reached."
            % (pct, f"{used:,}", f"{limit:,}", highest),
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": text,
            },
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

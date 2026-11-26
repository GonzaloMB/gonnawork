# One Claude Code sub-agent's transcript, compacted for the sub-agent window:
# transcript.py <agent-*.jsonl> [mtime seen] prints JSON
# { mtime, finished, running, started, items: [{k, ...}] } or { same: true } when the file
# hasn't changed since [mtime seen]. Items: prompt and msg (text sent to it), text (its
# words), tool (name, summary, and once answered res lines/first line, err), result (its
# SubagentHandback report to the parent).
import json, os, sys, time

STALE = 900  # unfinished but silent this long: lost (s), as subagents.py
TEXT = 6000  # chars kept per text item
KEEP = 160   # items kept after the prompt
HOME = os.path.expanduser("~")

log = sys.argv[1]
seen = float(sys.argv[2]) if len(sys.argv) > 2 else 0
try:
    mtime = os.path.getmtime(log)
except OSError:
    print(json.dumps({"missing": True}))
    sys.exit(0)
if seen and abs(mtime - seen) < 1e-6:
    print(json.dumps({"same": True}))
    sys.exit(0)

meta = {}
try:
    meta = json.load(open(log[: -len(".jsonl")] + ".meta.json"))
except Exception:
    pass


def tilde(s):
    return "~" + s[len(HOME):] if isinstance(s, str) and s.startswith(HOME + "/") else s


def clip(s, n):
    s = s or ""
    return s if len(s) <= n else s[:n].rstrip() + "…"


def summary(name, i):
    i = i or {}
    for k in {"Bash": ("description", "command"), "Read": ("file_path",), "Edit": ("file_path",), "Write": ("file_path",),
              "Grep": ("pattern",), "Glob": ("pattern",), "WebFetch": ("url",), "WebSearch": ("query",),
              "Agent": ("description",), "Task": ("description",), "Skill": ("skill",), "SendMessage": ("to",)}.get(name, ()):
        if i.get(k):
            return tilde(str(i[k]))
    for v in i.values():
        if isinstance(v, str) and v.strip():
            return tilde(v)
    return ""


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


items, tools, prompt, started, model = [], {}, None, None, None
with open(log, errors="ignore") as fh:
    for line in fh:
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        if t not in ("user", "assistant"):
            continue
        started = started or e.get("timestamp")
        msg = e.get("message") or {}
        content = msg.get("content")
        if t == "assistant":
            if msg.get("model") and not msg["model"].startswith("<"):
                model = msg["model"]
            for c in content if isinstance(content, list) else []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text" and c.get("text", "").strip():
                    items.append({"k": "text", "text": clip(c["text"].strip(), TEXT)})
                elif c.get("type") == "tool_use" and c.get("name") == "SubagentHandback":
                    # Its report to the parent.
                    items.append({"k": "result", "text": clip(str((c.get("input") or {}).get("message") or "").strip(), TEXT * 2)})
                elif c.get("type") == "tool_use":
                    it ={"k": "tool", "name": c.get("name") or "tool", "summary": clip(summary(c.get("name"), c.get("input")).replace("\n", " "), 240)}
                    tools[c.get("id")] = it
                    items.append(it)
            continue
        if e.get("isMeta"):
            continue
        if isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            for c in content:
                if not isinstance(c, dict) or c.get("type") != "tool_result":
                    continue
                it = tools.get(c.get("tool_use_id"))
                if not it:
                    continue
                body = text_of(c.get("content")).strip()
                lines = [l for l in body.split("\n") if l.strip()]
                it["res"] = len(lines)
                it["first"] = clip(lines[0].strip(), 200) if lines else ""
                it["err"] = bool(c.get("is_error"))
            continue
        text = text_of(content).strip()
        if not text or text.startswith("<system-reminder>") or text.startswith("<local-command") or text.startswith("<command-"):
            continue
        if prompt is None:
            prompt = {"k": "prompt", "text": clip(text, TEXT)}
        else:
            items.append({"k": "msg", "text": clip(text, TEXT)})

finished = bool(meta.get("finished"))
print(json.dumps({
    "mtime": mtime,
    "finished": finished,
    "running": not finished and time.time() - mtime < STALE,
    "started": started,
    "model": model,
    "type": meta.get("agentType"),
    "description": meta.get("description"),
    "tools": sum(1 for i in items if i["k"] == "tool"),
    "dropped": max(0, len(items) - KEEP),
    "items": ([prompt] if prompt else []) + items[-KEEP:],
}))

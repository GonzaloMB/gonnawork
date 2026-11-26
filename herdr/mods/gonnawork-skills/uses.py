# How often each skill ran in the last N days, from Claude Code's transcripts:
# uses.py <projects root> <days> prints JSON { "<skill>": {"count": n, "last": "<timestamp>"} }.
# A use is a Skill tool call by the model or a /skill command typed by the person. Names are
# as invoked ("docx", "anthropic-skills:docx"); the panel matches both forms.
import json, os, re, sys, time

root, days = sys.argv[1], int(sys.argv[2])
since = time.time() - days * 86400
cmd = re.compile(r"<command-name>/?([^<\s]+)</command-name>")
out = {}


def hit(name, ts):
    name = (name or "").strip().lstrip("/")
    if not name:
        return
    s = out.setdefault(name, {"count": 0, "last": None})
    s["count"] += 1
    if ts and (not s["last"] or ts > s["last"]):
        s["last"] = ts


for d in os.listdir(root) if os.path.isdir(root) else []:
    pdir = os.path.join(root, d)
    if not os.path.isdir(pdir):
        continue
    for f in os.listdir(pdir):
        path = os.path.join(pdir, f)
        if not f.endswith(".jsonl") or os.path.getmtime(path) < since:
            continue
        with open(path, errors="ignore") as fh:
            for line in fh:
                if '"Skill"' not in line and "command-name" not in line:
                    continue
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                msg = e.get("message") or {}
                content = msg.get("content")
                if e.get("type") == "assistant":
                    for c in content if isinstance(content, list) else []:
                        if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Skill":
                            i = c.get("input") or {}
                            hit(i.get("skill") or i.get("command"), e.get("timestamp"))
                elif e.get("type") == "user":
                    text = content if isinstance(content, str) else " ".join(c.get("text", "") for c in content if isinstance(c, dict)) if isinstance(content, list) else ""
                    for m in cmd.findall(text or ""):
                        hit(m, e.get("timestamp"))
print(json.dumps(out))

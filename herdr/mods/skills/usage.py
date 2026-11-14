# Reads Claude Code transcripts (~/.claude/projects/*/*.jsonl) from the last N days:
# Skill tool calls, /slash command uses, and token usage per project. Prints JSON.
import json, os, re, sys, time

# --live <projects root> <pid:cwd>...: each agent's session transcript (~/.claude/sessions/<pid>.json
# names it; else the newest in its folder): context now, tokens, turns, model, skills used.
if len(sys.argv) > 1 and sys.argv[1] == "--live":
    root, out = sys.argv[2], {}
    cmd = re.compile(r"<command-name>/?([^<\s]+)</command-name>")
    for spec in sys.argv[3:]:
        pid, _, cwd = spec.partition(":")
        path = None
        try:
            info = json.load(open(os.path.join(os.path.dirname(root), "sessions", pid + ".json")))
            cwd = info.get("cwd") or cwd
            cand = os.path.join(root, re.sub(r"[^A-Za-z0-9]", "-", cwd), info["sessionId"] + ".jsonl")
            if os.path.isfile(cand): path = cand
        except Exception: pass
        if not path:
            pdir = os.path.join(root, re.sub(r"[^A-Za-z0-9]", "-", cwd))
            files = [os.path.join(pdir, f) for f in os.listdir(pdir) if f.endswith(".jsonl")] if os.path.isdir(pdir) else []
            if not files: out[spec] = None; continue
            path = max(files, key=os.path.getmtime)
        s = {"id": os.path.basename(path)[:-6], "mtime": os.path.getmtime(path), "model": None, "context": 0, "input": 0,
             "cache_create": 0, "cache_read": 0, "output": 0, "turns": 0, "skills": {}, "started": None}
        seen = set()
        with open(path, errors="ignore") as fh:
            for line in fh:
                try: e = json.loads(line)
                except Exception: continue
                if not s["started"] and e.get("timestamp"): s["started"] = e["timestamp"]
                msg = e.get("message") or {}
                content = msg.get("content")
                if e.get("type") == "assistant" and not e.get("isSidechain"):
                    u = msg.get("usage") or {}
                    if msg.get("model") and not msg["model"].startswith("<"): s["model"] = msg["model"]
                    if u and msg.get("id") not in seen:
                        seen.add(msg.get("id"))
                        for k, f in (("input", "input_tokens"), ("cache_create", "cache_creation_input_tokens"), ("cache_read", "cache_read_input_tokens"), ("output", "output_tokens")):
                            s[k] += u.get(f, 0) or 0
                        s["context"] = sum(u.get(f, 0) or 0 for f in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
                    for c in content if isinstance(content, list) else []:
                        if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Skill":
                            name = ((c.get("input") or {}).get("skill") or (c.get("input") or {}).get("command") or "").lstrip("/")
                            if name: s["skills"][name] = s["skills"].get(name, 0) + 1
                elif e.get("type") == "user" and not e.get("isSidechain") and not e.get("isMeta"):
                    if isinstance(content, str) or (isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "text" for c in content)):
                        s["turns"] += 1
                    text = content if isinstance(content, str) else " ".join(c.get("text", "") for c in content if isinstance(c, dict)) if isinstance(content, list) else ""
                    for m in cmd.findall(text or ""): s["skills"][m] = s["skills"].get(m, 0) + 1
        out[spec] = s
    print(json.dumps(out))
    sys.exit(0)

root, days = sys.argv[1], int(sys.argv[2])
since = time.time() - days * 86400
skills, projects = {}, {}
cmd = re.compile(r"<command-name>/?([^<\s]+)</command-name>")
for d in os.listdir(root) if os.path.isdir(root) else []:
    pdir = os.path.join(root, d)
    if not os.path.isdir(pdir): continue
    for f in os.listdir(pdir):
        path = os.path.join(pdir, f)
        if not f.endswith(".jsonl") or os.path.getmtime(path) < since: continue
        proj = projects.setdefault(d, {"id": d, "cwd": None, "sessions": 0, "input": 0, "cache_create": 0, "cache_read": 0, "output": 0})
        proj["sessions"] += 1
        seen = set()
        with open(path, errors="ignore") as fh:
            for line in fh:
                if '"usage"' not in line and '"Skill"' not in line and "command-name" not in line and '"cwd"' not in line: continue
                try: e = json.loads(line)
                except Exception: continue
                if e.get("cwd"): proj["cwd"] = e["cwd"]
                msg = e.get("message") or {}
                content = msg.get("content")
                if e.get("type") == "assistant":
                    mid = msg.get("id")
                    u = msg.get("usage") or {}
                    if u and mid not in seen:
                        seen.add(mid)
                        proj["input"] += u.get("input_tokens", 0) or 0
                        proj["cache_create"] += u.get("cache_creation_input_tokens", 0) or 0
                        proj["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
                        proj["output"] += u.get("output_tokens", 0) or 0
                    for c in content if isinstance(content, list) else []:
                        if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Skill":
                            name = (c.get("input") or {}).get("skill") or (c.get("input") or {}).get("command")
                            if name:
                                s = skills.setdefault(name.lstrip("/"), {"count": 0, "last": None})
                                s["count"] += 1; s["last"] = e.get("timestamp")
                elif e.get("type") == "user":
                    text = content if isinstance(content, str) else " ".join(c.get("text", "") for c in content if isinstance(c, dict)) if isinstance(content, list) else ""
                    for m in cmd.findall(text or ""):
                        s = skills.setdefault(m, {"count": 0, "last": None})
                        s["count"] += 1; s["last"] = e.get("timestamp")
print(json.dumps({"skills": skills, "projects": list(projects.values())}))

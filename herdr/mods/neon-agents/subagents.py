# Claude Code's in-process sub-agents (Agent/Task tool) for each session, which Herdr
# can't see as terminals: subagents.py <projects root> <pid:cwd>... prints JSON
# { "<pid:cwd>": [{id, description, type, running, parent, started}] }.
# A session is found from ~/.claude/sessions/<pid>.json (no guessing: two may share a folder).
import json, os, re, sys, time

root, out, now = sys.argv[1], {}, time.time()
RECENT = 180    # finished ones stay listed this long (s)
STALE = 900     # unfinished but silent this long: lost (s)

for spec in sys.argv[2:]:
    pid, _, cwd = spec.partition(":")
    pdir, sid = None, None
    try:
        info = json.load(open(os.path.join(os.path.dirname(root), "sessions", pid + ".json")))
        cwd, sid = info.get("cwd") or cwd, info.get("sessionId")
    except Exception:
        pass
    pdir = os.path.join(root, re.sub(r"[^A-Za-z0-9]", "-", cwd))
    sdir = os.path.join(pdir, sid or "", "subagents")
    if not sid or not os.path.isdir(sdir):
        out[spec] = []
        continue
    agents = []
    for f in os.listdir(sdir):
        if not f.endswith(".meta.json"): continue
        aid = f[len("agent-"):-len(".meta.json")]
        log = os.path.join(sdir, f"agent-{aid}.jsonl")
        try: meta = json.load(open(os.path.join(sdir, f)))
        except Exception: continue
        mtime = os.path.getmtime(log) if os.path.exists(log) else os.path.getmtime(os.path.join(sdir, f))
        running = not meta.get("finished") and now - mtime < STALE
        if not running and now - mtime > RECENT: continue
        agents.append({"id": aid, "description": meta.get("description") or meta.get("agentType") or aid,
                       "type": meta.get("agentType"), "running": running, "depth": meta.get("spawnDepth", 1),
                       "tool": meta.get("toolUseId"), "log": log, "started": os.path.getctime(log) if os.path.exists(log) else mtime})
    # A nested one belongs to the sub-agent whose transcript made its tool call.
    for a in agents:
        a["parent"] = None
        if a["depth"] > 1 and a["tool"]:
            for b in agents:
                if b is not a and os.path.exists(b["log"]) and a["tool"] in open(b["log"], errors="ignore").read():
                    a["parent"] = b["id"]; break
    agents.sort(key=lambda a: a["started"])
    out[spec] = [{k: a[k] for k in ("id", "description", "type", "running", "parent")} for a in agents]
print(json.dumps(out))

# Claude Code's in-process sub-agents (Agent/Task tool) for each session, which Herdr
# can't see as terminals: subagents.py <home> <pid:cwd>... prints JSON
# { "<pid:cwd>": [{id, description, type, running, parent, started}] }.
# A session is found from <config>/sessions/<pid>.json (no guessing: two may share a folder).
import glob, json, os, re, sys, time

home, out, now = sys.argv[1], {}, time.time()
RECENT = 180    # finished ones stay listed this long (s)
STALE = 900     # unfinished but silent this long: lost (s)

# Every Claude Code config folder: ~/.claude, and others picked with CLAUDE_CONFIG_DIR
# (a second account in ~/.claude-b). Each keeps its own sessions/.
CONFIGS = [c for c in dict.fromkeys([os.path.join(home, ".claude"), *sorted(glob.glob(os.path.join(home, ".claude-*"))),
                                     os.environ.get("CLAUDE_CONFIG_DIR")])
           if c and os.path.isdir(os.path.join(c, "sessions"))]

def session(pid):
    # The newest wins: a pid is reused after a session that left its file behind.
    found = None
    for config in CONFIGS:
        try: info = json.load(open(os.path.join(config, "sessions", pid + ".json")))
        except Exception: continue
        if found is None or (info.get("startedAt") or 0) > (found[1].get("startedAt") or 0):
            found = (config, info)
    return found

def subagents_dir(config, sid, cwd):
    projects = os.path.join(config, "projects")
    sdir = os.path.join(projects, re.sub(r"[^A-Za-z0-9]", "-", cwd), sid, "subagents")
    if os.path.isdir(sdir): return sdir
    # The cwd changed (it went into a worktree) or was too long to name its folder: by id.
    return next(iter(glob.glob(os.path.join(glob.escape(projects), "*", glob.escape(sid), "subagents"))), None)

for spec in sys.argv[2:]:
    pid, _, cwd = spec.partition(":")
    out[spec] = []
    found = session(pid)
    sid = found and found[1].get("sessionId")
    sdir = sid and subagents_dir(found[0], sid, found[1].get("cwd") or cwd)
    if not sdir:
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
    out[spec] = [{k: a[k] for k in ("id", "description", "type", "running", "parent", "log")} for a in agents]
print(json.dumps(out))

# Claude Code usage from its transcripts (~/.claude/projects), sub-agents included, priced at
# Anthropic's API list prices: what the same usage would cost on the API (a subscription pays
# a flat fee, so this is a yardstick, not a bill). Prints JSON.
#
#   usage.py summary <projects root> <days>
#     { totals, mix, days: [{date, cost, output, sessions}], projects: [...], models: [...] }
#   usage.py live <projects root> <pid:cwd>...
#     { "<pid:cwd>": {model, context, cost, output, turns, started, hit, subagents} | null }
#     (~/.claude/sessions/<pid>.json names each agent's session; else the newest in its folder)
import datetime, glob, json, os, re, sys, time

# USD per million tokens: input, output, cache read. Cache writes cost 1.25x input (5-minute
# TTL) or 2x (1 hour); fast mode doubles everything. Longest prefix wins. A model that isn't
# here counts its tokens but no cost ("unpriced").
PRICES = {
    "claude-fable-5-2": (8, 40, 0.20), "claude-mythos-5-2": (8, 40, 0.20),
    "claude-fable-5-1": (10, 50, 0.25), "claude-mythos-5-1": (10, 50, 0.25),
    "claude-fable-5": (10, 50, 1.00), "claude-mythos-5": (10, 50, 1.00),
    "claude-opus-5-5": (4, 20, 0.20), "claude-opus-5": (5, 25, 0.50),
    "claude-opus-4-8": (5, 25, 0.50), "claude-opus-4-7": (5, 25, 0.50), "claude-opus-4-6": (5, 25, 0.50),
    "claude-sonnet-5-5": (2, 10, 0.10), "claude-sonnet-5": (2, 10, 0.20), "claude-sonnet-4-6": (3, 15, 0.30),
    "claude-haiku-5-5": (0.10, 0.50, 0.01), "claude-haiku-4-5": (1, 5, 0.10),
}
KEYS = sorted(PRICES, key=len, reverse=True)


def price(model):
    for k in KEYS:
        if (model or "").startswith(k):
            return PRICES[k]
    return None


def tokens(u):
    cc = u.get("cache_creation") or {}
    w1h = cc.get("ephemeral_1h_input_tokens") or 0
    w5m = cc.get("ephemeral_5m_input_tokens")
    write = u.get("cache_creation_input_tokens") or 0
    if w5m is None:
        w5m = max(0, write - w1h)
    return {"input": u.get("input_tokens") or 0, "write5m": w5m, "write1h": w1h,
            "read": u.get("cache_read_input_tokens") or 0, "output": u.get("output_tokens") or 0}


def cost(model, t, fast):
    p = price(model)
    if not p:
        return None
    i, o, r = p
    parts = {"input": t["input"] * i, "write": t["write5m"] * i * 1.25 + t["write1h"] * i * 2, "read": t["read"] * r, "output": t["output"] * o}
    k = (2 if fast else 1) / 1e6
    return {n: v * k for n, v in parts.items()}


def transcripts(root, since):
    """Each session file and its sub-agents' (files under <session>/subagents), once each."""
    seen = set()
    for pdir in glob.glob(os.path.join(root, "*")):
        if not os.path.isdir(pdir):
            continue
        for path in glob.glob(os.path.join(pdir, "*.jsonl")) + glob.glob(os.path.join(pdir, "*", "subagents", "*.jsonl")):
            real = os.path.realpath(path)
            if real in seen:
                continue
            seen.add(real)
            try:
                if os.path.getmtime(real) < since:
                    continue
            except OSError:
                continue
            yield os.path.basename(pdir), path, "/subagents/" in path


def assistant_turns(path):
    """(timestamp, model, usage, speed, entry) per API message, each message once."""
    seen = set()
    with open(path, errors="ignore") as fh:
        for line in fh:
            if '"usage"' not in line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") != "assistant":
                continue
            msg = e.get("message") or {}
            u = msg.get("usage")
            mid = msg.get("id") or e.get("requestId") or e.get("uuid")
            if not u or mid in seen:
                continue
            seen.add(mid)
            yield e.get("timestamp"), msg.get("model"), u, u.get("speed"), e


def local_day(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
    except Exception:
        return None


def summary(root, days):
    since = time.time() - days * 86400
    cutoff = datetime.datetime.fromtimestamp(since, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    today = datetime.date.today()
    day_list = [(today - datetime.timedelta(days=n)).isoformat() for n in range(days - 1, -1, -1)]
    by_day = {d: {"date": d, "cost": 0.0, "output": 0, "sessions": set()} for d in day_list}
    projects, models = {}, {}
    mix = {"input": [0, 0.0], "write": [0, 0.0], "read": [0, 0.0], "output": [0, 0.0]}
    unpriced, sessions = 0, set()
    for pid, path, sub in transcripts(root, since):
        sid = os.path.basename(os.path.dirname(os.path.dirname(path))) if sub else os.path.basename(path)[:-6]
        proj = projects.setdefault(pid, {"id": pid, "cwd": None, "sessions": set(), "cost": 0.0, "output": 0, "tokens": 0, "last": None})
        for ts, model, u, speed, e in assistant_turns(path):
            if not ts or ts < cutoff:
                continue
            if e.get("cwd") and not sub:
                proj["cwd"] = e["cwd"]
            t = tokens(u)
            c = cost(model, t, speed == "fast")
            total = sum(t.values())
            proj["sessions"].add(sid)
            sessions.add(sid)
            proj["tokens"] += total
            proj["output"] += t["output"]
            proj["last"] = max(proj["last"] or ts, ts)
            m = models.setdefault(model or "?", {"model": model or "?", "cost": 0.0, "tokens": 0, "output": 0, "priced": c is not None})
            m["tokens"] += total
            m["output"] += t["output"]
            for k, n in (("input", t["input"]), ("write", t["write5m"] + t["write1h"]), ("read", t["read"]), ("output", t["output"])):
                mix[k][0] += n
            day = by_day.get(local_day(ts))
            if day:
                day["output"] += t["output"]
                day["sessions"].add(sid)
            if c is None:
                unpriced += total
                continue
            s = sum(c.values())
            proj["cost"] += s
            m["cost"] += s
            for k in mix:
                mix[k][1] += c[k]
            if day:
                day["cost"] += s
    # Claude Code can keep one repo's sessions in two folders (renamed, moved): one row per repo.
    merged = {}
    for p in projects.values():
        if not p["tokens"]:
            continue
        m = merged.setdefault(p["cwd"] or p["id"], {"id": p["id"], "cwd": p["cwd"], "sessions": set(), "cost": 0.0, "output": 0, "tokens": 0, "last": None})
        m["sessions"] |= p["sessions"]
        for k in ("cost", "output", "tokens"):
            m[k] += p[k]
        m["last"] = max(m["last"] or p["last"], p["last"])
    plist = [dict(p, sessions=len(p["sessions"])) for p in merged.values()]
    out = {
        "days": [dict(d, sessions=len(d["sessions"])) for d in by_day.values()],
        "projects": sorted(plist, key=lambda p: -p["cost"]),
        "models": sorted((m for m in models.values() if m["tokens"]), key=lambda m: -m["cost"]),
        "mix": {k: {"tokens": v[0], "cost": v[1]} for k, v in mix.items()},
        "cost": sum(v[1] for v in mix.values()),
        "output": mix["output"][0],
        "sessions": len(sessions),
        "unpriced": unpriced,
        "since_days": days,
    }
    return out


def live(root, specs):
    out = {}
    for spec in specs:
        pid, _, cwd = spec.partition(":")
        path = None
        try:
            info = json.load(open(os.path.join(os.path.dirname(root), "sessions", pid + ".json")))
            cwd = info.get("cwd") or cwd
            cand = os.path.join(root, re.sub(r"[^A-Za-z0-9]", "-", cwd), info["sessionId"] + ".jsonl")
            if os.path.isfile(cand):
                path = cand
        except Exception:
            pass
        if not path:
            pdir = os.path.join(root, re.sub(r"[^A-Za-z0-9]", "-", cwd))
            files = glob.glob(os.path.join(pdir, "*.jsonl"))
            if not files:
                out[spec] = None
                continue
            path = max(files, key=os.path.getmtime)
        s = {"id": os.path.basename(path)[:-6], "model": None, "context": 0, "cost": 0.0, "output": 0, "turns": 0,
             "started": None, "read": 0, "prompt": 0, "subagents": 0, "priced": True}
        for ts, model, u, speed, e in assistant_turns(path):
            if e.get("isSidechain"):
                continue
            if model and not model.startswith("<"):
                s["model"] = model
            t = tokens(u)
            c = cost(model, t, speed == "fast")
            if c is None:
                s["priced"] = False
            else:
                s["cost"] += sum(c.values())
            s["output"] += t["output"]
            s["read"] += t["read"]
            s["prompt"] += t["input"] + t["write5m"] + t["write1h"] + t["read"]
            s["context"] = t["input"] + t["write5m"] + t["write1h"] + t["read"] + t["output"]
        # Its sub-agents run in the same session: their spend is part of it.
        for sp in glob.glob(os.path.join(path[:-6], "subagents", "*.jsonl")):
            s["subagents"] += 1
            for ts, model, u, speed, e in assistant_turns(sp):
                c = cost(model, tokens(u), speed == "fast")
                if c is not None:
                    s["cost"] += sum(c.values())
        with open(path, errors="ignore") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if not s["started"] and e.get("timestamp"):
                    s["started"] = e["timestamp"]
                content = (e.get("message") or {}).get("content")
                # A turn is something the person typed (tool results come back as user entries too).
                if e.get("type") == "user" and not e.get("isSidechain") and not e.get("isMeta"):
                    if isinstance(content, str) or (isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "text" for c in content)):
                        s["turns"] += 1
        s["hit"] = s["read"] / s["prompt"] if s["prompt"] else None
        out[spec] = s
    return out


if __name__ == "__main__":
    mode, root = sys.argv[1], sys.argv[2]
    if mode == "summary":
        print(json.dumps(summary(root, int(sys.argv[3]))))
    elif mode == "live":
        print(json.dumps(live(root, sys.argv[3:])))

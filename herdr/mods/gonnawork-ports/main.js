// Every TCP port something listens on, on the shown space's machine: which program, which
// folder, and which Herdr terminal (or Docker container) started it. "This space" keeps the
// ones from the shown space's terminals and project folders; "All" groups everything by space,
// then outside Herdr, Docker, and apps & system. Open one in the browser, jump to its terminal,
// or stop it: a terminal's foreground job gets ctrl+c (SIGINT to its process group), a
// background job SIGTERM, a container `docker stop`; still listening after a few seconds,
// it can be force-killed. Restart: a container gets `docker restart`; a terminal's foreground
// job ctrl+c, then its command typed again in that terminal. Stop, kill and restart always ask
// first. Apps & system are read-only.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, exec, hc, theme, home, run, terminals, layout, settings, nextCommand, openOverlay } from "herdr";

// Panels are glass. Over real blur (the layout's window_blur) a light window behind them
// would wash the text out, so the glass is denser there.
const panelGlass = () => (layout()?.window_blur ? "#16181ddb" : "#14161ba6");

const MOD = "gonnawork-ports";
const icon = (name) => `mods/${MOD}/${name}.svg`;
const C = { cyan: "#64d2ff", pink: "#ff375f", green: "#30d158", yellow: "#ffd60a", violet: "#bf5af2", red: "#ff453a", orange: "#ff9f0a" };

// Prints U (user, home), L (pid, port, address, command) for each listening socket,
// P (pid, ppid, pgid, tpgid, etime, user, command) and Q (pid, executable, which may hold
// spaces) for every process, C (pid, cwd) per listener.
const SCAN = String.raw`if command -v lsof >/dev/null 2>&1; then
  L=$(lsof -nP -iTCP -sTCP:LISTEN -F pcn 2>/dev/null | awk '/^p/{p=substr($0,2)} /^c/{c=substr($0,2)} /^n/{n=substr($0,2); if (match(n,/:[0-9]+$/)) print "L\t" p "\t" substr(n,RSTART+1) "\t" substr(n,1,RSTART-1) "\t" c}')
else
  L=$(ss -ltnpH 2>/dev/null | awk '{n=$4; if (!match(n,/:[0-9]+$/)) next; port=substr(n,RSTART+1); addr=substr(n,1,RSTART-1); pid=""; c=""; if (match($0,/pid=[0-9]+/)) pid=substr($0,RSTART+4,RLENGTH-4); if (match($0,/\(\("[^"]*"/)) c=substr($0,RSTART+3,RLENGTH-4); print "L\t" pid "\t" port "\t" addr "\t" c}')
fi
printf 'U\t%s\t%s\n' "$(id -un)" "$HOME"
printf '%s\n' "$L"
ps axww -o pid=,ppid=,pgid=,tpgid=,etime=,user=,command= 2>/dev/null | awk '{l=$0; sub(/^ *[0-9]+ +[0-9]+ +[0-9]+ +-?[0-9]+ +[^ ]+ +[^ ]+ */,"",l); print "P\t" $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" l}'
ps axww -o pid=,comm= 2>/dev/null | awk '{l=$0; sub(/^ *[0-9]+ +/,"",l); print "Q\t" $1 "\t" l}'
pids=$(printf '%s\n' "$L" | cut -f2 | grep -E '^[0-9]+$' | sort -u)
if [ -n "$pids" ]; then
  if [ -d /proc/self ]; then
    for p in $pids; do printf 'C\t%s\t%s\n' "$p" "$(readlink "/proc/$p/cwd" 2>/dev/null)"; done
  else
    lsof -a -p "$(printf '%s' "$pids" | tr '\n' ',')" -d cwd -Fpn 2>/dev/null | awk '/^p/{p=substr($0,2)} /^n/{print "C\t" p "\t" substr($0,2)}'
  fi
fi
true`;

const DOCKER = String.raw`command -v docker >/dev/null 2>&1 || exit 0
docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.RunningFor}}' 2>/dev/null
true`;

// Restart's first half: ctrl+c to the job's process group ($1), at most 10 s for it to go, then
// up to 3 s for its terminal's shell ($2) to take the terminal back. Exit 3: still running;
// 4: the shell has no prompt, so nothing must be typed.
const STOP_AND_WAIT = String.raw`g=$1 sh_pid=$2
kill -INT -- "-$g" 2>/dev/null || exit 2
n=0
while kill -0 -- "-$g" 2>/dev/null; do n=$((n + 1)); [ "$n" -ge 40 ] && exit 3; sleep 0.25; done
[ -n "$sh_pid" ] || exit 0
n=0
while [ "$n" -lt 30 ]; do
  s=$(ps -o pgid= -o tpgid= -p "$sh_pid" 2>/dev/null) || exit 4
  set -- $s
  [ "$1" = "$2" ] && exit 0
  n=$((n + 1)); sleep 0.1
done
exit 4`;

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "pwsh"]);
const AGENTS = new Set(["claude", "codex", "opencode", "gemini", "cursor-agent", "copilot", "amp", "pi", "kiro", "kiro-cli", "crush", "goose", "aider", "qwen", "grok", "kimi", "droid", "auggie"]);
const SYSTEM = /^(rapportd|ControlCe|ControlCenter|sharingd|launchd|mDNSResponder|cupsd|limactl|lima|colima|vpnkit|com\.docker|Docker|OrbStack|ssh|sshd|adb|Postman|figma_agent|Spotify|Dropbox|Raycast|Electron)/i;
const PROTECTED = /herdr/i;
const NON_HTTP = new Set([22, 25, 53, 587, 1433, 1521, 2181, 3306, 5432, 5672, 6379, 9092, 11211, 27017]);
const NON_HTTP_NAMES = /^(Postgres|Redis|MySQL|MongoDB)$/;

// First match over the job's commands names it; the icon is one of Herdr's in icons/.
const KNOWN = [
  [/next-server|\bnext\s+(dev|start)\b/, "Next.js", "next"],
  [/\bvite\b/, "Vite", "vite"],
  [/\bastro\b/, "Astro", "astro"],
  [/\bnuxt\b|\bnuxi\b/, "Nuxt", "nuxt"],
  [/storybook/, "Storybook", null],
  [/webpack/, "Webpack", "webpack"],
  [/\bexpo\b/, "Expo", "expo"],
  [/react-native|\bmetro\b/, "Metro", null],
  [/\bwrangler\b/, "Wrangler", "wrangler"],
  [/\bnetlify\b/, "Netlify", "netlify"],
  [/\bvercel\b/, "Vercel", "vercel"],
  [/\bsupabase\b/, "Supabase", "supabase"],
  [/\bprisma\b.*\bstudio\b/, "Prisma Studio", "prisma"],
  [/\bturbo\b/, "Turbo", "turbo"],
  [/\besbuild\b/, "esbuild", "esbuild"],
  [/\btauri\b/, "Tauri", "tauri"],
  [/manage\.py\s+runserver/, "Django", "django-admin"],
  [/\bfastapi\b/, "FastAPI", "fastapi"],
  [/\buvicorn\b/, "Uvicorn", "python"],
  [/\bflask\b/, "Flask", "flask"],
  [/\bgunicorn\b/, "Gunicorn", "python"],
  [/jupyter/, "Jupyter", "jupyter"],
  [/http\.server/, "http.server", "python"],
  [/\brails\b|\bpuma\b/, "Rails", "ruby"],
  [/artisan\s+serve/, "Laravel", "php"],
  [/\bpostgres\b|\bpostmaster\b/, "Postgres", "psql"],
  [/\bredis\b/, "Redis", "redis-cli"],
  [/\bmysql/, "MySQL", "mysql"],
  [/\bmongo/, "MongoDB", "mongosh"],
  [/\bollama\b/, "Ollama", "ollama"],
  [/\bnginx\b/, "nginx", "nginx"],
  [/\bcaddy\b/, "Caddy", "caddy"],
  [/\bphp\b/, "PHP", "php"],
  [/\bbun\b/, "Bun", "bun"],
  [/\bdeno\b/, "Deno", "deno"],
  [/\bpython[\d.]*\b/, "Python", "python"],
  [/\bruby\b/, "Ruby", "ruby"],
  [/\bjava\b/, "Java", "java"],
  [/\bgo\s+run\b/, "Go", "go"],
  [/\bnode\b|\bnpm\b|\bpnpm\b|\byarn\b/, "Node", "node"],
];

const basename = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();
// A process's program: its executable's name (paths like "Application Support" hold spaces).
const program = (q) => basename(q?.exe || (q?.cmd ?? "").trim().split(/\s+/)[0]).replace(/^-/, "");
const isShell = (q) => SHELLS.has(program(q));
// A shell people type into (a terminal's own shell): only flags, no `-c` and no script.
const isInteractive = (q) => isShell(q) && q.cmd.trim().split(/\s+/).slice(1).every((a) => a.startsWith("-") && !/^-[A-Za-z]*c/.test(a));

function isAgent(q) {
  const b = program(q);
  if (AGENTS.has(b)) return true;
  const tok = (q?.cmd ?? "").trim().split(/\s+/);
  return ["node", "bun", "deno"].includes(b) && Boolean(tok[1]) && AGENTS.has(basename(tok[1]).replace(/\.(m?js|cjs)$/, ""));
}

// Apps and the OS: another user's, under the system folders or an Applications folder
// (Homebrew's Python also runs from a Python.app, so a bundle alone doesn't count).
function isSystem(p, comm, user, h) {
  if (!p) return true;
  if (user && p.user !== user) return true;
  if (/^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/Library\/|\/Applications\/)/.test(p.cmd) || p.cmd.startsWith(`${h}/Applications/`)) return true;
  return SYSTEM.test(program(p)) || SYSTEM.test(comm ?? "");
}

// One word for sh, zsh or bash, quoted only when it needs it.
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// The command that started a job, to type again: its argv as the OS has it. A program that
// rewrote its title (npm, setproctitle) leaves one string and blanks; that's typed as it reads,
// unless it doesn't read like a command ("next-server (v15)", "gunicorn: master").
function commandLine(argv) {
  const words = [...(argv ?? [])];
  while (words.length && words[words.length - 1] === "") words.pop();
  if (!words.length) return null;
  if (words.length < argv.length || words.length === 1) {
    const text = words.join(" ").trim();
    return /[()[\]<>|;&:"'`$\\]/.test(text) ? null : text;
  }
  return words.map(shq).join(" ");
}

const failure = (r) => (r.stderr ?? "").trim().split("\n").pop() || `exit ${r.code}`;
const failed = (e) => ({ code: 1, stderr: String(e?.message ?? e) });

const exposed = (addr) => !/^(127\.|\[::1\]$|localhost$)/.test(addr ?? "");
const urlHost = (addr) => (!addr || addr === "*" || addr === "0.0.0.0" || addr === "[::]" || /^(127\.|\[::1\]$|localhost$)/.test(addr) ? "localhost" : addr);

function tilde(p, h = home()) {
  return p === h ? "~" : p?.startsWith(h + "/") ? "~" + p.slice(h.length) : p ?? "";
}

// "/usr/local/bin/node /Users/me/app/node_modules/.bin/next dev" → "node ~/app/node_modules/.bin/next dev"
function pretty(q, h) {
  const cmd = (q?.cmd ?? "").trim();
  const exe = q?.exe && cmd.startsWith(q.exe) ? q.exe : cmd.split(/\s+/)[0];
  const rest = cmd.slice(exe.length).trim();
  return [basename(exe).replace(/^-/, ""), ...(rest ? rest.split(/\s+/).map((s) => tilde(s, h)) : [])].join(" ");
}

function seconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime ?? "");
  return m ? ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}

function ago(s) {
  if (s === null || s === undefined) return null;
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function parseScan(text) {
  const listen = [], procs = new Map(), cwd = new Map();
  let user = null, h = null;
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "L" && f.length >= 5 && f[2]) listen.push({ pid: Number(f[1]) || null, port: Number(f[2]), addr: f[3], comm: f[4] });
    else if (f[0] === "P" && f.length >= 8) procs.set(Number(f[1]), { pid: Number(f[1]), ppid: Number(f[2]), pgid: Number(f[3]), tpgid: Number(f[4]), etime: f[5], user: f[6], cmd: f.slice(7).join("\t").trim() });
    else if (f[0] === "Q" && procs.has(Number(f[1]))) procs.get(Number(f[1])).exe = f.slice(2).join("\t").trim();
    else if (f[0] === "C") cwd.set(Number(f[1]), f[2] ?? "");
    else if (f[0] === "U") { user = f[1] || null; h = f[2] || null; }
  }
  return { listen, procs, cwd, user, home: h };
}

function parseDocker(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const [id, name, image, ports, dir, since] = line.split("\t");
    if (!id || !name) continue;
    const published = new Map();
    const re = /(?:^|[\s,])([^\s,]*):(\d+)->(\d+)\/tcp/g;
    for (let m = re.exec(ports ?? ""); m; m = re.exec(ports ?? "")) if (!published.has(Number(m[2]))) published.set(Number(m[2]), { host: Number(m[2]), inner: Number(m[3]), addr: m[1] });
    out.push({ id, name, image, dir: dir || null, since: (since ?? "").replace(/ ago$/, ""), ports: [...published.values()] });
  }
  return out;
}

function findPath(node, test, path = []) {
  if (!node) return null;
  const here = [...path, node];
  if (test(node)) return here;
  for (const child of node.children ?? []) {
    const found = findPath(child, test, here);
    if (found) return found;
  }
  return null;
}

export default class Ports extends View {
  init(_props, cx) {
    this.rows = null;
    this.error = null;
    this.on = null;
    this.home = home();
    this.scope = localStorage.getItem("scope") === "all" ? "all" : "space";
    this.folded = new Set(["system"]);
    this.open = null;
    this.pending = null;
    this.pendingRestart = null;
    this.stopping = new Map();
    this.restarting = new Set();
    this.coming = new Map();
    this.groups = new Map();
    this.note = null;
    this.pids = new Map();
    this.roots = new Map();
    this.procs = new Map();
    this.shellPids = new Set();
    this.sig = "";
    this.last = 0;
    this.busy = false;
    this.again = false;
    this.seen = false;
    this.width = 368;
    this.filter = "";
    this.input = InputState.new({ placeholder: "Filter by port, program or folder…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    // Every 3s while on screen, every 20s while the panel is closed.
    cx.timer.every(3000, (cx) => { if (this.visible() || Date.now() - this.last > 20000) this.scan(cx); });
    this.scan(cx);
    // Keys: gonnawork-ports.space, .all, .refresh. The confirmations answer with
    // gonnawork-ports.confirm-stop and gonnawork-ports.confirm-restart.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "space" || c === "all") { this.scope = c; localStorage.setItem("scope", c); }
        else if (c === "refresh") { this.pids.clear(); this.roots.clear(); this.scan(cx); }
        else if (c === "confirm-stop") this.stopConfirmed(cx);
        else if (c === "confirm-restart") this.restartConfirmed(cx);
        cx.notify();
      }
    });
  }

  machine() {
    return spaces().find((s) => s.active)?.machine ?? null;
  }

  // False while this panel's block sits hidden in the layout (a closed side panel, another
  // stack child). A copy outside the layout (a pane, an overlay) counts as shown.
  visible() {
    const path = findPath(layout(), (n) => n.content?.mod === MOD);
    if (!path) return true;
    return path.every((n, i) => {
      if (n.hidden) return false;
      const up = path[i - 1];
      return !up || up.type !== "stack" || (up.active ?? up.children?.[0]?.id) === n.id;
    });
  }

  scan(cx) {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    const on = this.machine();
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        const [s, d, shells] = await Promise.all([
          exec("sh", ["-c", SCAN], { on, timeout: 15000 }),
          exec("sh", ["-c", DOCKER], { on, timeout: 5000 }).catch(() => null),
          this.shells(on),
        ]);
        const scan = parseScan(s.stdout);
        const roots = await this.spaceRoots(on, scan.home ?? home());
        changed = this.apply(scan, d && d.code === 0 ? parseDocker(d.stdout) : [], shells, roots, on);
        if (this.error) { this.error = null; changed = true; }
      } catch (e) {
        this.error = String(e?.message ?? e);
        changed = true;
      }
      this.on = on;
      this.busy = false;
      this.last = Date.now();
      if (this.again) { this.again = false; this.scan(cx); }
      if (changed) cx.notify();
    });
  }

  // Shell pid → its Herdr terminal, for every live terminal on that machine (pids kept 30s).
  async shells(on) {
    const now = Date.now();
    const list = (terminals() ?? []).filter((k) => k.state === "live" && (on ? k.address.startsWith(on + "/") : !k.address.includes("/")));
    const live = new Set(list.map((k) => k.address));
    for (const a of [...this.pids.keys()]) if (!live.has(a)) this.pids.delete(a);
    await Promise.all(list.filter((k) => now - (this.pids.get(k.address)?.at ?? 0) >= 30000).map(async (k) => {
      let g = null;
      try { g = JSON.parse((await hc(["get", k.address, "--json"])).stdout); } catch {}
      this.pids.set(k.address, { pid: g?.pid ?? null, labels: g?.labels ?? null, at: now });
    }));
    const out = new Map();
    for (const k of list) {
      const e = this.pids.get(k.address);
      const labels = { ...(e?.labels ?? {}), ...(k.labels ?? {}) };
      if (e?.pid) out.set(e.pid, { ...k, labels, where: k.where ?? labels.where ?? k.address });
    }
    return out;
  }

  // Each space's project folders: the git top level of where its terminals are now.
  async spaceRoots(on, h) {
    const tabSpace = new Map();
    for (const s of spaces()) if ((s.machine ?? null) === on) for (const tb of s.tabs ?? []) tabSpace.set(tb.id, s.id);
    const dirs = new Map();
    for (const p of panes()) {
      const sid = tabSpace.get(p.tab);
      if (sid && p.cwd && !dirs.has(p.cwd)) dirs.set(p.cwd, sid);
    }
    const out = [];
    for (const [dir, sid] of dirs) {
      const key = `${on}|${dir}`;
      if (!this.roots.has(key)) {
        let root = dir;
        try {
          const r = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], { on, timeout: 5000 });
          if (r.code === 0 && r.stdout.trim()) root = r.stdout.trim();
        } catch {}
        this.roots.set(key, root);
      }
      const root = this.roots.get(key);
      if (root && root !== h && root !== "/") out.push({ root, space: sid });
    }
    return out;
  }

  apply({ listen, procs, cwd, user, home: h }, containers, shells, roots, on) {
    this.procs = procs;
    this.groups = new Map();
    for (const q of procs.values()) {
      if (!this.groups.has(q.pgid)) this.groups.set(q.pgid, []);
      this.groups.get(q.pgid).push(q);
    }
    this.shellPids = new Set(shells.keys());
    this.home = h ?? home();
    const spaceOfDir = (dir) => {
      let best = null;
      for (const r of roots) if (dir && (dir === r.root || dir.startsWith(r.root + "/")) && (!best || r.root.length > best.root.length)) best = r;
      return best?.space ?? null;
    };
    const spaceOfTerm = (k) => {
      const id = k.labels?.["herdr.space"];
      return id ? (on ? `${on}/${id}` : id) : null;
    };
    const rootOf = (sid, dir) => roots.filter((r) => r.space === sid && dir && (dir === r.root || dir.startsWith(r.root + "/"))).sort((a, b) => b.root.length - a.root.length)[0]?.root ?? null;
    const byPort = new Map();
    for (const c of containers) for (const p of c.ports) byPort.set(p.host, { ...c, inner: p.inner, addr: p.addr });

    const rows = new Map();
    for (const l of listen) {
      const key = `${l.pid}:${l.port}`;
      const prev = rows.get(key);
      if (prev) { prev.exposed = prev.exposed || exposed(l.addr); continue; }
      const p = procs.get(l.pid) ?? null;
      const chain = [];
      for (let q = p, n = 0; q && q.pid > 1 && n < 64; q = procs.get(q.ppid), n++) chain.push(q);
      const at = chain.findIndex((q) => shells.has(q.pid));
      const term = at >= 0 ? shells.get(chain[at].pid) : null;
      const within = at >= 0 ? chain.slice(0, at) : chain;
      // The job: the listener and its parents up to the agent or shell people started it from.
      const stop = within.findIndex((q, i) => i > 0 && (isAgent(q) || isInteractive(q)));
      const job = stop >= 0 ? within.slice(0, stop) : within;
      const starter = stop >= 0 && isAgent(within[stop]) ? within[stop] : null;
      const me = p ?? { cmd: l.comm ?? "" };
      const self = me.cmd;
      const container = byPort.get(l.port) ?? null;
      const agentSelf = !container && isAgent(me);
      const kind = container ? "docker" : agentSelf || isSystem(p, l.comm, user, this.home) ? "system" : "dev";
      const dir = cwd.get(l.pid) || "";
      const sid = container ? spaceOfDir(container.dir) : kind !== "dev" ? null : (term && spaceOfTerm(term)) || spaceOfDir(dir);
      const texts = job.filter((q) => !isShell(q)).map((q) => q.cmd);
      if (!texts.length) texts.push(self);
      const known = KNOWN.find(([re]) => (container ? [container.image] : texts).some((s) => re.test(s)));
      const top = [...job].reverse().find((q) => !isShell(q));
      rows.set(key, {
        key: container ? `c:${container.id}:${l.port}` : key,
        port: l.port, pid: l.pid, addr: l.addr, exposed: exposed(l.addr), kind, dir, self, container,
        title: container ? container.name : known?.[1] ?? (program(me) || l.comm || "?"),
        sub: container ? container.image : pretty(top ?? me, this.home),
        icon: container ? (known?.[2] ?? "docker") : known?.[2] ?? null,
        term: kind === "docker" ? null : term,
        starter: starter && term ? term.program?.name ?? program(starter) : starter ? program(starter) : null,
        space: sid,
        root: sid ? rootOf(sid, container ? container.dir : dir) : null,
        since: container ? container.since : ago(seconds(p?.etime)),
        agentSelf, inTerminal: Boolean(term),
        guarded: PROTECTED.test(self),
      });
    }
    // Containers whose ports nothing here listens on (Linux publishes them through iptables).
    const covered = new Set([...rows.values()].map((r) => r.port));
    for (const c of containers) for (const p of c.ports) {
      if (covered.has(p.host)) continue;
      const known = KNOWN.find(([re]) => re.test(c.image));
      rows.set(`c:${c.id}:${p.host}`, {
        key: `c:${c.id}:${p.host}`, port: p.host, pid: null, addr: p.addr, exposed: exposed(p.addr), kind: "docker", dir: c.dir ?? "", self: "",
        container: { ...c, inner: p.inner }, title: c.name, sub: c.image, icon: known?.[2] ?? "docker", term: null, starter: null,
        space: spaceOfDir(c.dir), root: null, since: c.since, agentSelf: false, inTerminal: false, guarded: false,
      });
    }

    const list = [...rows.values()].sort((a, b) => a.port - b.port);
    const live = new Set(list.map((r) => r.key));
    const gone = [];
    for (const [k, s] of this.stopping) if (!live.has(k)) { gone.push(s.label); this.stopping.delete(k); }
    if (gone.length) this.flash({ text: `Stopped ${gone.join(", ")}`, ok: true });
    // A restarted job is back once its port listens again from another process.
    let news = gone.length > 0;
    for (const [port, c] of this.coming) {
      if (list.some((r) => r.port === port && r.key !== c.from)) this.flash({ text: `Restarted ${c.label}`, ok: true });
      else if (Date.now() > c.until) this.flash({ text: `Typed ${c.cmd} in ${c.where}, but :${port} isn't listening yet`, ok: false });
      else continue;
      this.coming.delete(port);
      news = true;
    }
    if (this.open && !live.has(this.open)) this.open = null;
    this.rows = list;
    this.on = on;
    const sig = on + "|" + list.map((r) => `${r.key}|${r.since}|${r.space}|${r.exposed}|${r.term?.address}`).join(",");
    const changed = sig !== this.sig || news;
    this.sig = sig;
    return changed;
  }

  flash(note) {
    this.note = note;
    this.noteAt = Date.now();
  }

  // How to stop a row, from the last scan.
  plan(r) {
    if (r.container) return { kind: "docker", id: r.container.id, key: `c:${r.container.id}` };
    const p = this.procs.get(r.pid);
    if (!p) return { kind: "pid", pid: r.pid, key: `p:${r.pid}` };
    // Its whole process group (npm and its children, like ctrl+c), unless that group holds a
    // terminal's shell, an agent or Herdr itself: then only the listener.
    const members = this.groups.get(p.pgid) ?? [];
    const safe = p.pgid > 1 && !members.some((q) => this.shellPids.has(q.pid) || isInteractive(q) || isAgent(q) || PROTECTED.test(q.cmd));
    if (!safe) return { kind: "pid", pid: r.pid, key: `p:${r.pid}` };
    return { kind: "group", pgid: p.pgid, sig: p.tpgid > 0 && p.tpgid === p.pgid ? "INT" : "TERM", key: `g:${p.pgid}` };
  }

  // Apps & system (an agent's own port included) are read-only: quitting one from a port
  // list can break the OS or an app. Herdr's own processes are never stopped either.
  stoppable(r) {
    if (r.kind === "system" || r.guarded) return false;
    return Boolean(r.container || r.pid);
  }

  label(r) {
    return `:${r.port} ${r.title}`;
  }

  // What Stop or Force does to a row, in words.
  describe(r, force) {
    const p = this.plan(r);
    if (p.kind === "docker") return `Runs docker ${force ? "kill" : "stop"} ${r.container.name}`;
    const sig = force ? "SIGKILL" : p.kind === "group" && p.sig === "INT" ? "ctrl+c (SIGINT)" : "SIGTERM";
    return p.kind === "group" ? `Sends ${sig} to process group ${p.pgid}: the command and its children` : `Sends ${sig} to pid ${p.pid} only`;
  }

  // Stopping and killing always ask first, in Herdr's confirm dialog. It answers with
  // `<mod>.confirm-stop`, and the rows are looked up again then, from the latest scan.
  askStop(rs, force, group) {
    rs = rs.filter((r) => this.stoppable(r));
    if (!rs.length) return;
    this.pending = { keys: rs.map((r) => r.key), force, on: this.on, at: Date.now() };
    const one = rs.length === 1 ? rs[0] : null, verb = force ? "Force kill" : "Stop";
    const title = one ? `${verb} ${this.label(one)}?` : `${verb} ${rs.length} servers${group ? ` in ${group}` : ""}?`;
    const from = !one ? "" : one.term ? ` Started from ${one.starter ? `${one.starter} · ` : ""}${one.term.where}.` : one.kind === "dev" ? " Not started from Herdr." : "";
    const what = one ? `${this.describe(one, force)}.${from}` : `${rs.map((r) => this.label(r)).join(", ")}. Each gets ctrl+c or SIGTERM, containers docker stop.`;
    const warn = force ? " A kill can't be caught: the program gets no chance to clean up or save." : "";
    this.confirm(title, what + warn, "confirm-stop");
  }

  confirm(title, detail, command) {
    openOverlay({ mod: "confirm", kind: "dialog", width: 460, height: 200, props: { title, detail, command: { name: `${MOD}.${command}` } } });
  }

  stopConfirmed(cx) {
    const p = this.pending;
    this.pending = null;
    if (!p || p.on !== this.on || Date.now() - p.at > 120000) return;
    const rs = (this.rows ?? []).filter((r) => p.keys.includes(r.key) && this.stoppable(r));
    if (rs.length) this.stop(rs, p.force, cx);
    else this.flash({ text: "Already stopped", ok: true });
  }

  stop(rs, force, cx) {
    const on = this.on;
    const plans = new Map();
    for (const r of rs) {
      const p = this.plan(r);
      if (!plans.has(p.key)) plans.set(p.key, { p, rows: [] });
      plans.get(p.key).rows.push(r);
    }
    for (const r of rs) this.stopping.set(r.key, { at: Date.now(), label: this.label(r) });
    this.flash({ text: `${force ? "Killing" : "Stopping"} ${rs.map((r) => this.label(r)).join(", ")}…`, ok: true });
    cx.spawn(async (cx) => {
      const errors = [];
      for (const { p, rows } of plans.values()) {
        let r;
        try {
          if (p.kind === "docker") r = await exec("docker", [force ? "kill" : "stop", p.id], { on, timeout: 60000 });
          else if (p.kind === "group") r = await exec("kill", [`-${force ? "KILL" : p.sig}`, "--", `-${p.pgid}`], { on });
          else r = await exec("kill", [`-${force ? "KILL" : "TERM"}`, String(p.pid)], { on });
        } catch (e) {
          r = failed(e);
        }
        if (r.code !== 0) {
          errors.push(`${rows.map((x) => this.label(x)).join(", ")}: ${failure(r)}`);
          for (const x of rows) this.stopping.delete(x.key);
        }
      }
      if (errors.length) this.flash({ text: `Couldn't stop ${errors.join("; ")}`, ok: false });
      cx.notify();
      this.scan(cx);
    });
    cx.timer.after(700, (cx) => this.scan(cx));
    cx.timer.after(3200, (cx) => { this.scan(cx); cx.notify(); });
  }

  // Restart: a container (docker restart), or a server that is its Herdr terminal's foreground
  // job (ctrl+c, then its command typed again there). Others don't say how to start them again.
  restartable(r, plan = this.plan(r)) {
    return this.stoppable(r) && (plan.kind === "docker" || (Boolean(r.term) && plan.kind === "group" && plan.sig === "INT"));
  }

  // What to type to start a terminal's foreground job again, from herdr-core's view of that
  // terminal: only while the job is the row's process group, and not a shell or an agent.
  relaunch(g, pgid) {
    const fg = g?.foreground;
    if (!fg || fg.pid !== pgid) return null;
    const q = { cmd: (fg.argv ?? []).join(" "), exe: fg.name };
    if (isShell(q) || isAgent(q)) return null;
    const cmd = commandLine(fg.argv);
    if (!cmd) return null;
    return { cmd: fg.cwd && g.cwd && fg.cwd !== g.cwd ? `cd ${shq(fg.cwd)} && ${cmd}` : cmd, shell: g.pid ?? null };
  }

  // Restarting asks first too, saying what it will run or type, and where.
  askRestart(r, cx) {
    const plan = this.plan(r);
    if (!this.restartable(r, plan)) return;
    const base = { plan: plan.key, on: this.on, at: Date.now() };
    if (plan.kind === "docker") {
      this.pendingRestart = base;
      return this.confirm(`Restart ${this.label(r)}?`, `Runs docker restart ${r.container.name}: docker stop, then start again with the same ports and settings.`, "confirm-restart");
    }
    cx.spawn(async (cx) => {
      let g = null;
      try { g = JSON.parse((await hc(["get", r.term.address, "--json"])).stdout); } catch {}
      const job = this.relaunch(g, plan.pgid);
      if (!job) {
        this.flash({ text: `Can't restart ${this.label(r)}: can't tell which command started it`, ok: false });
        return cx.notify();
      }
      this.pendingRestart = { ...base, ...job, address: r.term.address, where: r.term.where };
      this.confirm(`Restart ${this.label(r)}?`, `Sends ctrl+c to process group ${plan.pgid}, waits for it to exit, then types ${job.cmd} in ${r.term.where}.`, "confirm-restart");
    });
  }

  // The row is looked up again from the latest scan, by its process group or container.
  restartConfirmed(cx) {
    const p = this.pendingRestart;
    this.pendingRestart = null;
    if (!p || p.on !== this.on || Date.now() - p.at > 120000) return;
    const r = (this.rows ?? []).find((x) => this.stoppable(x) && this.plan(x).key === p.plan);
    const plan = r && this.plan(r);
    if (!r || !this.restartable(r, plan)) return this.flash({ text: "It stopped in the meantime: nothing restarted", ok: false });
    if (this.restarting.has(plan.key)) return;
    this.restarting.add(plan.key);
    if (plan.kind === "docker") this.restartContainer(r, plan, cx);
    else this.restartJob(r, plan, p, cx);
  }

  restartContainer(r, plan, cx) {
    const on = this.on, label = this.label(r);
    this.flash({ text: `Restarting ${label}…`, ok: true });
    cx.spawn(async (cx) => {
      const res = await exec("docker", ["restart", plan.id], { on, timeout: 90000 }).catch(failed);
      this.restarting.delete(plan.key);
      this.flash(res.code === 0 ? { text: `Restarted ${label}`, ok: true } : { text: `Couldn't restart ${label}: ${failure(res)}`, ok: false });
      cx.notify();
      this.scan(cx);
    });
  }

  // ctrl+c and wait; only once the shell has its prompt back is the command typed in.
  // Still running after 10 s, the row offers Force, as after Stop.
  restartJob(r, plan, p, cx) {
    const on = this.on, label = this.label(r);
    this.flash({ text: `Restarting ${label}: sent ctrl+c…`, ok: true });
    cx.spawn(async (cx) => {
      const s = await exec("sh", ["-c", STOP_AND_WAIT, "sh", String(plan.pgid), String(p.shell ?? "")], { on, timeout: 20000 }).catch(failed);
      let note = null;
      if (s.code === 3) {
        this.stopping.set(r.key, { at: 0, label });
        note = `${label} is still running after ctrl+c: Force kills it`;
      } else if (s.code === 4) note = `Stopped ${label}, but ${p.where} has no prompt back: nothing typed`;
      else if (s.code !== 0) note = `Couldn't restart ${label}: ${failure(s)}`;
      else {
        const t = await hc(["send", p.address, p.cmd]).catch(failed);
        if (t.code !== 0) note = `Stopped ${label}, but couldn't type ${p.cmd}: ${failure(t)}`;
        else this.coming.set(r.port, { label, from: r.key, cmd: p.cmd, where: p.where, until: Date.now() + 60000 });
      }
      this.restarting.delete(plan.key);
      this.flash(note ? { text: note, ok: false } : { text: `Restarting ${label}: typed ${p.cmd} in ${p.where}…`, ok: true });
      cx.notify();
      this.scan(cx);
    });
  }

  url(r) {
    return `http://${urlHost(r.addr)}:${r.port}`;
  }

  web(r) {
    return !this.on && r.kind !== "system" && !NON_HTTP.has(r.container?.inner ?? r.port) && !NON_HTTP_NAMES.test(r.title);
  }

  browse(r) {
    exec("sh", ["-c", 'command -v open >/dev/null 2>&1 && exec open "$1" || exec xdg-open "$1"', "sh", this.url(r)]);
  }

  copy(r, cx) {
    const url = this.url(r);
    cx.spawn(async (cx) => {
      const c = await exec("sh", ["-c", 'if command -v pbcopy >/dev/null 2>&1; then printf %s "$1" | pbcopy; elif command -v wl-copy >/dev/null 2>&1; then printf %s "$1" | wl-copy; else printf %s "$1" | xclip -selection clipboard; fi', "sh", url]).catch(() => ({ code: 1 }));
      this.flash(c.code === 0 ? { text: `Copied ${url}`, ok: true } : { text: "Couldn't copy: no clipboard tool", ok: false });
      cx.notify();
    });
  }

  go(r) {
    const k = r.term;
    const pane = panes().find((p) => p.terminal === k.address);
    if (!pane) return run("terminal.peek", { terminal: k.address });
    const sid = k.labels?.["herdr.space"];
    if (sid) run("space.select", { id: this.on ? `${this.on}/${sid}` : sid });
    run("tab.select", { id: pane.tab });
    run("pane.focus", { terminal: k.address });
  }

  logs(r) {
    run("pane.split", { direction: "down", argv: ["docker", "logs", "-f", "--tail", "200", r.container.name] });
  }

  render(cx) {
    const t = theme();
    const vis = this.visible();
    if (vis && !this.seen && Date.now() - this.last > 2500) this.scan(cx);
    this.seen = vis;
    if (this.rows !== null && !this.busy && this.machine() !== this.on) this.scan(cx);
    if (this.note && Date.now() - (this.noteAt ?? 0) > 6000 && !this.stopping.size && !this.restarting.size && !this.coming.size) this.note = null;

    const rows = this.rows ?? [];
    const q = this.filter.trim().toLowerCase();
    const shown = q ? rows.filter((r) => [String(r.port), r.title, r.sub, r.dir, r.term?.where ?? "", r.container?.name ?? ""].some((s) => (s ?? "").toLowerCase().includes(q))) : rows;
    const active = spaces().find((s) => s.active);
    const mine = shown.filter((r) => r.space && r.space === active?.id);
    const servers = rows.filter((r) => r.kind !== "system").length;
    const pill = `${servers} server${servers === 1 ? "" : "s"} · ${rows.length} port${rows.length === 1 ? "" : "s"}${this.on ? ` · on ${this.on}` : ""}`;

    return v_flex().id("ports-root").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(panelGlass()).border_1().border_color("#ffffff14").text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); } })
      .child(this.header(t, pill))
      .child(h_flex().px(10).pt(10).gap(8).flex_none().items_center()
        .child(h_flex().p(2).gap(2).flex_none().rounded(8).border_1().border_color("#ffffff14").bg("#00000033")
          .child(this.seg(t, "space", "This space", rows.filter((r) => r.space && r.space === active?.id).length))
          .child(this.seg(t, "all", "All", servers)))
        .child(div().id("filter").flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(8).border_1().border_color("#ffffff14").bg("#00000033")
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground))))
      .when(Boolean(this.note), (el) => el.child(this.noteBar(t)))
      .when(Boolean(this.error), (el) => el.child(div().mx(10).mt(8).px(8).py(5).rounded(6).bg(C.red + "10").text_size(11).text_color(C.red).child(`Scan failed: ${this.error}`)))
      .child(v_flex().id("ports-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
        .children(this.scope === "space" ? this.spaceView(t, active, mine, shown, q) : this.allView(t, active, shown, q)));
  }

  header(t, pill) {
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color("#ffffff14")
      .child(svg(icon("ports")).size(15).flex_none().text_color(C.violet))
      .child(div().font_semibold().child("Ports"))
      .child(div().px(6).h(18).flex().items_center().rounded(9).border_1().border_color("#ffffff1a").text_size(10).text_color(t.muted).truncate().child(pill))
      .child(div().flex_1())
      .child(div().id("reload").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover((s) => s.bg("#ffffff0f").text_color(C.violet))
        .on_click((_e, cx) => { this.pids.clear(); this.roots.clear(); this.scan(cx); })
        .child("↻"));
  }

  seg(t, id, label, n) {
    const on = this.scope === id;
    return h_flex().id(`scope-${id}`).h(24).px(9).gap(5).flex_none().items_center().rounded(6)
      .bg(on ? "#ffffff17" : "#00000000").text_size(11.5).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.scope = id; localStorage.setItem("scope", id); cx.notify(); })
      .child(label)
      .child(div().text_size(10.5).text_color(on ? C.violet : t.dim).child(String(n)));
  }

  noteBar(t) {
    const color = this.note.ok ? C.green : C.red;
    return div().mx(10).mt(8).px(8).py(5).rounded(6).bg(color + "10").text_size(11).text_color(color).child(this.note.text);
  }

  empty(t, text) {
    return div().py(30).flex().justify_center().text_size(12).text_color(t.dim).child(text);
  }

  spaceView(t, active, mine, shown, q) {
    if (this.rows === null) return [this.empty(t, "Looking for ports…")];
    const out = [];
    if (mine.length) out.push(this.section(t, `space-${active.id}`, active.name, mine, C.cyan));
    else out.push(this.empty(t, q ? "Nothing matches in this space" : "Nothing listening from this space"));
    const rest = shown.filter((r) => r.kind !== "system" && !(r.space && r.space === active?.id)).length;
    if (rest) out.push(h_flex().id("show-all").flex_none().justify_center().gap(6).py(6).rounded(8).text_size(11.5).text_color(t.dim)
      .hover((s) => s.bg("#ffffff08").text_color(t.foreground))
      .on_click((_e, cx) => { this.scope = "all"; localStorage.setItem("scope", "all"); cx.notify(); })
      .child(`${rest} more elsewhere`).child(div().text_color(C.violet).child("Show all →")));
    return out;
  }

  allView(t, active, shown, q) {
    if (this.rows === null) return [this.empty(t, "Looking for ports…")];
    if (!shown.length) return [this.empty(t, q ? "Nothing matches" : "Nothing is listening")];
    const sections = [];
    const order = [active, ...spaces().filter((s) => s.id !== active?.id && (s.machine ?? null) === this.on)].filter(Boolean);
    for (const s of order) {
      const list = shown.filter((r) => r.space === s.id && r.kind !== "system");
      if (list.length) sections.push(this.section(t, `space-${s.id}`, s.name, list, s.id === active?.id ? C.cyan : C.green));
    }
    const known = new Set(order.map((s) => s.id));
    const loose = shown.filter((r) => r.kind === "dev" && !(r.space && known.has(r.space)));
    if (loose.length) sections.push(this.section(t, "loose", "Outside Herdr", loose, C.yellow));
    const docker = shown.filter((r) => r.kind === "docker" && !(r.space && known.has(r.space)));
    if (docker.length) sections.push(this.section(t, "docker", "Docker", docker, C.violet));
    const system = shown.filter((r) => r.kind === "system");
    if (system.length) sections.push(this.section(t, "system", "Apps & system", system, t.dim));
    return sections;
  }

  section(t, id, title, list, color) {
    const folded = this.folded.has(id);
    const quick = list.filter((r) => this.stoppable(r) && !this.stopping.has(r.key));
    return v_flex().gap(6).flex_none()
      .child(h_flex().id(`sec-${id}`).gap(6).items_center().h(22)
        .on_click((_e, cx) => { folded ? this.folded.delete(id) : this.folded.add(id); cx.notify(); })
        .child(div().w(10).text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
        .child(div().flex_none().max_w(200).truncate().text_size(10.5).font_semibold().text_color(t.dim).child(title.toUpperCase()))
        .child(div().text_size(10.5).text_color(color).child(String(list.length)))
        .child(div().flex_1().h(1).bg("#ffffff0f"))
        .when(id === "system", (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("read-only")))
        .when(quick.length > 1, (el) => el.child(this.pill(t, `stop-all-${id}`, "Stop all", C.red, false, () => this.askStop(quick, false, title)))))
      .when(!folded, (el) => el.children(list.map((r) => this.row(t, r))));
  }

  pill(t, id, label, color, solid, action) {
    return div().id(id).h(22).px(8).flex().flex_none().items_center().rounded(6).border_1().border_color("#ffffff1a")
      .text_size(11).text_color(color).when(solid, (el) => el.bg(color + "22"))
      .hover((s) => s.bg(color + "22"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label);
  }

  iconButton(t, id, icon, color, action) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover((s) => s.bg("#ffffff0f").text_color(color))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(icon).size(14));
  }

  // Stop (asks first); a spinner while it goes, then Force (asks too) if it's still listening.
  stopControl(t, r) {
    if (!this.stoppable(r)) return r.agentSelf ? div().flex_none().px(4).text_size(10.5).text_color(t.dim).child("agent") : null;
    const s = this.stopping.get(r.key);
    if (s && Date.now() - s.at < 3000) return div().w(24).flex_none().flex().justify_center().text_color(C.red).frames(SPIN, 90);
    if (s) return this.pill(t, `force-${r.key}`, "Force", C.red, true, () => this.askStop([r], true));
    return this.iconButton(t, `stop-${r.key}`, icon("stop"), C.red, () => this.askStop([r], false));
  }

  // Restart (asks first), a spinner while it goes. Null where there's no way to restart it.
  restartControl(t, r) {
    if (this.stopping.has(r.key) || !this.restartable(r)) return null;
    if (this.restarting.has(this.plan(r).key)) return div().w(24).flex_none().flex().justify_center().text_color(C.yellow).frames(SPIN, 90);
    return this.iconButton(t, `restart-${r.key}`, icon("restart"), C.yellow, (cx) => this.askRestart(r, cx));
  }

  row(t, r) {
    const open = this.open === r.key;
    const color = r.kind === "docker" ? C.violet : r.kind === "system" ? t.muted : C.cyan;
    const mono = settings().font_family || "JetBrains Mono";
    const where = r.term ? (r.starter ? `${r.starter} · ${r.term.where}` : r.term.where) : r.kind === "dev" ? "not in Herdr" : "";
    const folder = r.root && r.dir && r.dir !== r.root ? r.dir.slice(r.root.length + 1) : tilde(r.dir, this.home);
    const meta = [r.container ? `→ ${r.container.inner}` : folder, where, r.since].filter(Boolean).join(" · ");
    const narrow = this.width < 330;
    // Null for read-only rows (apps & system): no stop control, and child() refuses null.
    const control = this.stopControl(t, r);
    const restart = this.restartControl(t, r);
    return v_flex().id(`row-${r.key}`).flex_none().px(10).py(7).gap(3).rounded(8).border_1()
      .border_color(open ? "#ffffff26" : "#ffffff0d").bg("#ffffff05")
      .hover((s) => s.bg("#ffffff0a").border_color("#ffffff1f"))
      .when(this.stopping.has(r.key), (el) => el.opacity(0.6))
      .on_click((_e, cx) => { this.open = open ? null : r.key; cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().w(52).flex_none().font_family(mono).text_size(12.5).font_semibold().text_color(color).child(`:${r.port}`))
        .child(div().size(14).flex_none().flex().items_center().justify_center()
          .when(Boolean(r.icon), (el) => el.child(svg(`icons/${r.icon}.svg`).size(13).text_color(t.muted))))
        .child(div().flex_none().max_w(narrow ? 90 : 160).truncate().font_medium().child(r.title))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(narrow ? "" : r.sub))
        .when(this.web(r), (el) => el.child(this.iconButton(t, `open-${r.key}`, icon("globe"), C.cyan, () => this.browse(r))))
        .when(Boolean(r.term), (el) => el.child(this.iconButton(t, `go-${r.key}`, icon("terminal"), C.green, () => this.go(r))))
        .when(Boolean(r.container), (el) => el.child(this.iconButton(t, `logs-${r.key}`, icon("logs"), C.violet, () => this.logs(r))))
        .when(Boolean(restart), (el) => el.child(restart))
        .when(Boolean(control), (el) => el.child(control)))
      .child(h_flex().pl(60).gap(6).items_center().min_w(0)
        .when(r.exposed, (el) => el.child(div().flex_none().px(5).h(15).flex().items_center().rounded(4).bg(C.orange + "1f").text_size(9.5).text_color(C.orange).child("LAN")))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta)))
      .when(open, (el) => el.child(this.details(t, r, mono)));
  }

  details(t, r, mono) {
    const plan = r.pid || r.container ? this.plan(r) : null;
    const how = r.guarded ? "Herdr's own: not stopped from here"
      : r.agentSelf ? (r.inTerminal ? "The agent itself: close its terminal to stop it" : "The agent itself: not stopped from here")
      : r.kind === "system" ? "App or system: read-only here, so nothing breaks. Quit it from the app itself"
      : !plan ? "No process to stop"
      : plan.kind === "docker" ? "Stop runs docker stop; Force, docker kill; Restart, docker restart. All ask first"
      : this.restartable(r, plan) ? `Stop sends ctrl+c (SIGINT) to process group ${plan.pgid}; Restart does too, then types its command again in ${r.term.where}. Both ask first`
      : (plan.kind === "group" ? `Stop sends ${plan.sig === "INT" ? "ctrl+c (SIGINT)" : "SIGTERM"} to process group ${plan.pgid}. Asks first` : `Stop sends SIGTERM to pid ${r.pid} only. Asks first`)
        + (r.term ? ". No Restart: it isn't its terminal's foreground job (an agent or & started it)" : ". No Restart: it wasn't started from a Herdr terminal");
    const facts = [r.pid ? `pid ${r.pid}` : null, r.container ? `container ${r.container.id.slice(0, 12)}` : null, `bound to ${r.addr || "*"}:${r.port}`, r.exposed ? "reachable from your network" : "this machine only"].filter(Boolean).join(" · ");
    const pills = [];
    if (this.web(r)) pills.push(this.pill(t, `copy-${r.key}`, "Copy URL", C.cyan, false, (cx) => this.copy(r, cx)));
    if (r.dir && !r.container) pills.push(this.pill(t, `here-${r.key}`, "Terminal here", C.green, false, () => run("tab.new", { folder: r.dir })));
    if (this.stoppable(r)) pills.push(this.pill(t, `kill-${r.key}`, "Force kill", C.red, false, () => this.askStop([r], true)));
    return v_flex().pl(60).pt(4).gap(5)
      .child(div().text_size(11).font_family(mono).text_color(t.muted).child(r.container ? `${r.container.image} · ${r.container.name}` : r.self))
      .child(div().text_size(10.5).text_color(t.dim).child(facts))
      .when(Boolean(r.dir), (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(tilde(r.dir, this.home))))
      .child(div().text_size(10.5).text_color(t.dim).child(how))
      .when(pills.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(pills)));
  }
}

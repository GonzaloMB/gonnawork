// Claude Code usage: each agent in the shown space (context used of its window, what the
// session would cost on the API, output, turns, cache hits), every claude-multi
// account's limits, the last 30 days (cost per day, where the tokens and the money go, per
// project and model) and every agent's status. Costs are at API list prices (usage.py): on a
// subscription they're a yardstick, not a bill. The window comes from Claude Code's /context.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, theme, home, run, agents, appHome, terminals, hc, layout, checking } from "herdr";
import { readdir } from "fs/promises";

// Panels are glass. Over real blur (the layout's window_blur) a light window behind them
// would wash the text out, so the glass is denser there.
const panelGlass = () => (layout()?.window_blur ? "#16181ddb" : "#14161ba6");

const MOD = "gonnawork-stats";
const C = { cyan: "#64d2ff", pink: "#ff375f", green: "#30d158", yellow: "#ffd60a", violet: "#bf5af2", red: "#ff453a" };
// Token kinds, in a fixed order; validated for CVD separation on the panel's dark surface.
const MIX = [["input", "Input", "#3987e5"], ["write", "Cache write", "#d95926"], ["read", "Cache read", "#199e70"], ["output", "Output", "#c98500"]];
const BAR = "#3987e5";
const STATUS = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b" };
const AGENT = { working: C.cyan, blocked: C.yellow, done: C.green };
// Where claude-multi (github.com/GonzaloMB/claude-multi) keeps each account's usage;
// claude-dual is its earlier name.
const ACCOUNT_STATES = () => [home() + "/.config/claude-multi/state", home() + "/.config/claude-dual/state"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmt(n) {
  n = Math.round(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function usd(n) {
  n = n || 0;
  if (n >= 1000) return "$" + (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n >= 100) return "$" + Math.round(n);
  if (n >= 10) return "$" + n.toFixed(1);
  return "$" + n.toFixed(2);
}

const pct = (x) => `${Math.round(x * 100)}%`;
const basename = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();
const day = (iso) => { const [, m, d] = iso.split("-"); return `${MONTHS[Number(m) - 1]} ${Number(d)}`; };

function since(ts) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60000));
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
}

function until(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d - Date.now() < 86400000 ? hm : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`;
}

// Full: green under 60%, amber under 85%, red after. Always shown with its number.
const level = (x, warn = 0.6, crit = 0.85) => (x >= crit ? "critical" : x >= warn ? "warning" : "good");

// Every root-to-node path whose node passes `test`.
function findPaths(node, test, path = [], out = []) {
  if (!node) return out;
  const here = [...path, node];
  if (test(node)) out.push(here);
  for (const child of node.children ?? []) findPaths(child, test, here, out);
  return out;
}

export default class Stats extends View {
  init(_props, cx) {
    this.sum = null;
    this.sumError = null;
    this.sumAt = 0;
    this.live = {};
    this.liveKey = null;
    this.window = null;
    this.accounts = null;
    this.width = 368;
    this.seen = false;
    if (checking()) return;
    cx.timer.every(300000, (cx) => { if (this.visible()) this.loadSummary(cx); });
    cx.timer.every(15000, (cx) => { if (this.visible()) { this.loadLive(cx); this.loadAccounts(cx); } });
    cx.timer.every(3600000, (cx) => this.loadWindow(cx));
    this.loadWindow(cx);
  }

  // False while every copy of this panel in the layout is hidden (a closed side panel, another
  // stack child). The layout can hold more than one: a tab in the panel and a docked block.
  visible() {
    const paths = findPaths(layout(), (n) => n.content?.mod === MOD);
    if (!paths.length) return true;
    return paths.some((path) => path.every((n, i) => {
      if (n.hidden) return false;
      const up = path[i - 1];
      return !up || up.type !== "stack" || (up.active ?? up.children?.[0]?.id) === n.id;
    }));
  }

  script() {
    return appHome() + `/mods/${MOD}/usage.py`;
  }

  loadSummary(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [this.script(), "summary", home() + "/.claude/projects", "30"], { timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
        this.sum = JSON.parse(r.stdout);
        this.sumAt = Date.now();
        this.sumError = null;
      } catch (e) {
        this.sumError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // The shown space's agents on this computer, the focused one first.
  spaceAgents() {
    const space = spaces().find((s) => s.active);
    if (!space || space.machine) return [];
    return agents().filter((a) => a.space === space.id).sort((a, b) => Number(b.focused) - Number(a.focused)).slice(0, 4);
  }

  loadLive(cx) {
    const list = this.spaceAgents();
    cx.spawn(async (cx) => {
      const specs = {};
      for (const a of list) {
        try {
          const g = JSON.parse((await hc(["get", a.address, "--json"])).stdout);
          specs[a.address] = `${g.foreground?.pid ?? 0}:${g.foreground?.cwd ?? g.cwd ?? ""}`;
        } catch {}
      }
      let data = {};
      const args = [...new Set(Object.values(specs))];
      if (args.length) {
        try {
          const r = await exec("python3", [this.script(), "live", home() + "/.claude/projects", ...args], { timeout: 30000 });
          data = JSON.parse(r.stdout);
        } catch {}
      }
      this.live = Object.fromEntries(list.map((a) => [a.address, specs[a.address] ? data[specs[a.address]] ?? null : null]));
      cx.notify();
    });
  }

  // claude-multi's view of every account (written by its usage.zsh): limits used, when they reset.
  loadAccounts(cx) {
    cx.spawn(async (cx) => {
      const out = [];
      let dir = null, ids = [];
      for (const d of ACCOUNT_STATES()) {
        ids = (await readdir(d).catch(() => []))
          .map((f) => /^usage-([a-z])\.json$/.exec(f)?.[1]).filter(Boolean).sort();
        if (ids.length) { dir = d; break; }
      }
      const active = dir ? ((await readTextFile(dir + "/active").catch(() => null)) ?? "a").trim() : "a";
      for (const id of ids) {
        const text = await readTextFile(`${dir}/usage-${id}.json`).catch(() => null);
        if (!text) continue;
        try {
          const u = JSON.parse(text);
          out.push({ id, at: u.at, active: active === id, limits: u.limits ?? [] });
        } catch {}
      }
      const next = out.length ? out : null;
      if (JSON.stringify(next) !== JSON.stringify(this.accounts)) { this.accounts = next; cx.notify(); }
    });
  }

  // The context window Claude Code gives sessions here (plan dependent), from its /context:
  // runs locally, no model call, hooks off.
  loadWindow(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", 'CC_MULTI_RENEWING=1 exec claude -p /context --no-session-persistence --settings \'{"disableAllHooks":true}\'', "ctx"], { cwd: home(), timeout: 45000 });
        const tok = /\*\*Tokens:\*\*\s*[\d.]+[kKM]?\s*\/\s*([\d.]+)\s*([kKM]?)/.exec(r.stdout);
        const model = /\*\*Model:\*\*\s*(\S+)/.exec(r.stdout)?.[1] ?? null;
        if (tok) this.window = { model, size: Number(tok[1]) * (tok[2] === "M" ? 1e6 : tok[2] ? 1e3 : 1) };
      } catch {}
      cx.notify();
    });
  }

  windowFor(model) {
    if (/haiku-4-5/.test(model ?? "")) return 200000;
    return this.window?.size ?? 1000000;
  }

  render(cx) {
    const t = theme();
    const vis = this.visible();
    if (vis && !this.seen && !checking()) {
      if (Date.now() - this.sumAt > 120000) this.loadSummary(cx);
      this.loadLive(cx);
      this.loadAccounts(cx);
    }
    this.seen = vis;
    const key = this.spaceAgents().map((a) => a.address).join(",") + "|" + spaces().find((s) => s.active)?.id;
    if (key !== this.liveKey && !checking()) { this.liveKey = key; this.loadLive(cx); }
    const perRow = this.width > 760 ? 4 : this.width > 330 ? 2 : 1;
    return v_flex().id("stats-root").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(panelGlass()).border_1().border_color("#ffffff14").text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); } })
      .child(this.header(t))
      .child(v_flex().id("stats-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(18)
        .child(this.spaceSection(t, perRow))
        .when(Boolean(this.accounts), (el) => el.child(this.accountsSection(t)))
        .child(this.periodSection(t, perRow))
        .child(this.projectsSection(t))
        .when((this.sum?.models.length ?? 0) > 1, (el) => el.child(this.modelsSection(t)))
        .child(this.agentsSection(t))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(
          "Costs at Anthropic's API list prices, sub-agents included: what the same usage would cost on the API. A subscription pays a flat fee, so read them as a yardstick. Cache writes are priced by how long they're kept (5 min: 1.25× input, 1 h: 2×).")));
  }

  header(t) {
    const pill = this.sum ? `${usd(this.sum.cost)} · 30 days` : null;
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color("#ffffff14")
      .child(svg(`mods/${MOD}/stats.svg`).size(15).flex_none().text_color(C.cyan))
      .child(div().font_semibold().child("Stats"))
      .when(Boolean(pill), (el) => el.child(div().px(6).h(18).flex().items_center().rounded(9).border_1().border_color("#ffffff1a").text_size(10).text_color(t.muted).child(pill)))
      .child(div().flex_1())
      .child(div().id("reload").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover((s) => s.bg("#ffffff0f").text_color(C.cyan))
        .on_click((_e, cx) => { this.loadSummary(cx); this.loadLive(cx); this.loadAccounts(cx); this.loadWindow(cx); })
        .child("↻"));
  }

  title(t, text, right) {
    return h_flex().gap(6).items_center().h(20)
      .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase()))
      .child(div().flex_1().h(1).bg("#ffffff0f"))
      .when(Boolean(right), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(right)));
  }

  tile(t, label, value, hint) {
    return v_flex().h(72).px(8).py(7).gap(2).min_w(0).flex_1().rounded(10).border_1().border_color("#ffffff0d").bg("#ffffff05")
      .child(div().text_size(10).text_color(t.dim).truncate().child(label.toUpperCase()))
      .child(div().text_size(16).font_semibold().text_color(t.foreground).truncate().child(value))
      .when(Boolean(hint), (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(hint)));
  }

  grid(tiles, perRow) {
    const rows = [];
    for (let i = 0; i < tiles.length; i += perRow) rows.push(h_flex().gap(8).children(tiles.slice(i, i + perRow)));
    return rows;
  }

  // A labelled meter: the number is always written next to the bar, color only backs it up.
  meter(t, id, label, frac, right, warn, crit) {
    const lv = level(frac, warn, crit);
    const word = lv === "critical" ? (id.startsWith("ctx") ? "compacts soon" : "near the limit") : lv === "warning" ? (id.startsWith("ctx") ? "filling up" : "high") : null;
    // The track: panel padding, card padding and borders, and room for the scrollbar.
    const inner = Math.max(40, this.width - 52);
    return v_flex().gap(4).flex_none()
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().flex_none().text_color(t.muted).child(label))
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(pct(frac)))
        .when(Boolean(word), (el) => el.child(h_flex().flex_none().gap(4).items_center()
          .child(div().size(6).rounded(3).bg(STATUS[lv])).child(div().text_size(10.5).text_color(t.muted).child(word))))
        .child(div().flex_1())
        .when(Boolean(right), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(right))))
      .child(div().id(id).h(4).w_full().rounded(2).bg("#ffffff0d")
        .child(div().h(4).rounded(2).bg(STATUS[lv]).w(Math.max(3, inner * Math.min(1, frac)))));
  }

  // ---- This space ----

  spaceSection(t, perRow) {
    const mine = this.spaceAgents();
    return v_flex().gap(8).flex_none()
      .child(this.title(t, "This space", mine.length ? String(mine.length) : null))
      .children(mine.length ? mine.map((a) => this.sessionCard(t, a, perRow)) : [div().text_size(11.5).text_color(t.dim).child("No agent running in this space")]);
  }

  sessionCard(t, a, perRow) {
    const s = this.live[a.address];
    const claude = a.app === "claude-code" || a.program?.key === "claude";
    const head = h_flex().gap(8).items_center()
      .child(div().size(7).flex_none().rounded(4).bg(AGENT[a.status] ?? t.dim))
      .child(div().flex_none().font_medium().text_size(12.5).child(a.program?.name ?? a.app ?? "agent"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(a.title))
      .when(Boolean(s?.model), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color("#ffffff1a")
        .text_size(10).text_color(t.muted).child(s.model.replace(/^claude-/, ""))));
    const card = v_flex().id(`sess-${a.address}`).flex_none().p(10).gap(9).rounded(10).border_1()
      .border_color(a.focused ? "#ffffff26" : "#ffffff0d").bg("#ffffff05").hover((st) => st.bg("#ffffff0a"))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(head);
    if (!claude || s === null) return card.child(div().text_size(11).text_color(t.dim).child(claude ? "No transcript for this session yet" : "Only Claude Code sessions have transcripts"));
    if (s === undefined) return card.child(div().text_size(11).text_color(t.dim).child("Reading session…"));
    const win = this.windowFor(s.model);
    const tiles = [
      this.tile(t, "Session cost", `≈${usd(s.cost)}`, s.subagents ? `incl. ${s.subagents} sub-agent${s.subagents === 1 ? "" : "s"}` : "at API prices"),
      this.tile(t, "Output", fmt(s.output), "tokens written"),
      this.tile(t, "Turns", String(s.turns), s.started ? `running ${since(s.started)}` : null),
      this.tile(t, "Cache hits", s.hit === null ? "—" : pct(s.hit), "of the prompt read from cache"),
    ];
    return card
      .child(this.meter(t, `ctx-${a.address}`, "Context", s.context / win, `${fmt(s.context)} / ${fmt(win)}`))
      .children(this.grid(tiles, perRow));
  }

  // ---- Accounts ----

  accountsSection(t) {
    const label = { five_hour: "5 hours", seven_day: "Week" };
    return v_flex().gap(8).flex_none()
      .child(this.title(t, "Accounts", "claude-multi"))
      .children(this.accounts.map((acc) => v_flex().id(`acc-${acc.id}`).flex_none().p(10).gap(8).rounded(10).border_1().border_color("#ffffff0d").bg("#ffffff05")
        .child(h_flex().gap(6).items_center()
          .child(div().font_medium().text_size(12.5).child(`Account ${acc.id.toUpperCase()}`))
          .when(acc.active, (el) => el.child(div().px(6).h(16).flex().items_center().rounded(8).border_1().border_color("#ffffff26").text_size(10).text_color(t.muted).child("default")))
          .child(div().flex_1())
          .when(Boolean(acc.at), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`updated ${since(acc.at)} ago`))))
        .children(acc.limits.filter((l) => label[l.kind]).map((l) => this.meter(t, `acc-${acc.id}-${l.kind}`, label[l.kind], (l.percentUsed ?? 0) / 100,
          l.resetsAt ? `resets ${until(l.resetsAt)}` : null, 0.7, 0.9)))));
  }

  // ---- Last 30 days ----

  periodSection(t, perRow) {
    const s = this.sum;
    if (!s) return v_flex().gap(8).flex_none().child(this.title(t, "Last 30 days"))
      .child(div().text_size(11.5).text_color(this.sumError ? C.red : t.dim).child(this.sumError ? `Couldn't read transcripts: ${this.sumError}` : "Reading transcripts…"));
    const projects = s.projects.length;
    const tiles = [
      this.tile(t, "API-equivalent", usd(s.cost), s.unpriced ? `${fmt(s.unpriced)} tok unpriced` : "what the API would charge"),
      this.tile(t, "Output", fmt(s.output), "tokens Claude wrote"),
      this.tile(t, "Sessions", String(s.sessions), `${projects} project${projects === 1 ? "" : "s"}`),
    ];
    return v_flex().gap(10).flex_none()
      .child(this.title(t, "Last 30 days"))
      .children(this.grid(tiles, perRow > 1 ? Math.min(perRow, 3) : 1))
      .child(this.daily(t, s.days))
      .child(this.mix(t, s));
  }

  // Cost per day, one bar each (hover for the numbers), oldest to today.
  daily(t, days) {
    const max = Math.max(...days.map((d) => d.cost), 0);
    const H = 64;
    return v_flex().gap(4).flex_none()
      .child(h_flex().text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child("Cost per day"))
        .child(div().child(max ? `top ${usd(max)}` : "")))
      .child(h_flex().h(H).gap(2).items_end().border_b(1).border_color("#ffffff1a")
        .children(days.map((d, i) => div().id(`day-${i}`).flex_1().h_full().flex().flex_col().justify_end()
          .tooltip(`${day(d.date)}: ${d.cost ? usd(d.cost) : "no use"}${d.sessions ? ` · ${d.sessions} session${d.sessions === 1 ? "" : "s"} · ${fmt(d.output)} output` : ""}`)
          .child(d.cost > 0
            ? div().w_full().h(Math.max(3, (H - 2) * d.cost / max)).rounded_tl(3).rounded_tr(3).bg(BAR)
            : div().w_full().h(1).bg("#ffffff14")))))
      .child(h_flex().text_size(10).text_color(t.dim)
        .child(div().flex_1().child(day(days[0].date)))
        .child(div().child("today")));
  }

  // Where the tokens go and where the money goes: same four kinds, two bars.
  mix(t, s) {
    const inner = Math.max(60, this.width - 32);
    const tokTotal = MIX.reduce((n, [k]) => n + s.mix[k].tokens, 0) || 1;
    const costTotal = s.cost || 1;
    const stacked = (id, share) => h_flex().id(id).h(10).w_full().gap(2)
      .children(MIX.filter(([k]) => share(k) > 0).map(([k, , color], i, list) => {
        const w = Math.max(2, (inner - 2 * (list.length - 1)) * share(k));
        return div().h(10).w(w).bg(color)
          .when(i === 0, (el) => el.rounded_tl(3).rounded_bl(3))
          .when(i === list.length - 1, (el) => el.rounded_tr(3).rounded_br(3));
      }));
    const row = (label, bar) => v_flex().gap(3).child(div().text_size(10.5).text_color(t.dim).child(label)).child(bar);
    return v_flex().gap(8).flex_none()
      .child(row("Tokens", stacked("mix-tok", (k) => s.mix[k].tokens / tokTotal)))
      .child(row("Cost", stacked("mix-cost", (k) => s.mix[k].cost / costTotal)))
      .child(v_flex().gap(4).pt(2).children(MIX.map(([k, label, color]) => h_flex().id(`mix-${k}`).gap(7).items_center().text_size(11)
        .child(div().size(8).flex_none().rounded(2).bg(color))
        .child(div().w(80).flex_none().text_color(t.foreground).child(label))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${fmt(s.mix[k].tokens)} tok · ${pct(s.mix[k].tokens / tokTotal)}`))
        .child(div().flex_none().text_color(t.foreground).child(usd(s.mix[k].cost)))
        .child(div().w(34).flex_none().text_color(t.dim).child(pct(s.mix[k].cost / costTotal))))));
  }

  // One bar per row, same hue: the label says which is this project.
  bars(t, rows, limit = 6) {
    const top = rows.filter((r) => r.value > 0).slice(0, limit);
    const max = top[0]?.value || 1;
    const inner = Math.max(60, this.width - 32);
    return top.length
      ? v_flex().gap(8).children(top.map((r) => v_flex().id(r.id).gap(3).tooltip(r.tip ?? r.label)
        .child(h_flex().gap(8).text_size(11.5)
          .child(div().flex_1().min_w(0).truncate().text_color(r.here ? t.foreground : t.muted).when(Boolean(r.here), (el) => el.font_semibold()).child(r.label))
          .child(div().flex_none().text_color(t.muted).child(r.text)))
        .child(div().h(4).w_full().rounded(2).bg("#ffffff0a")
          .child(div().h(4).rounded(2).bg(BAR).w(Math.max(3, inner * r.value / max))))))
      : div().text_size(11.5).text_color(t.dim).child("Nothing yet");
  }

  here() {
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return pane?.cwd || f?.cwd || spaces().find((s) => s.active)?.folder || null;
  }

  projectsSection(t) {
    const cwd = this.here();
    const rows = (this.sum?.projects ?? []).map((p, i) => {
      const here = Boolean(cwd && p.cwd && (cwd === p.cwd || cwd.startsWith(p.cwd + "/")));
      return { id: `proj-${i}`, label: `${basename(p.cwd) || p.id}${here ? " · here" : ""}`, here, value: p.cost,
        text: `${usd(p.cost)} · ${p.sessions} session${p.sessions === 1 ? "" : "s"}`, tip: `${p.cwd ?? p.id}: ${fmt(p.tokens)} tokens, ${fmt(p.output)} output` };
    });
    return v_flex().gap(8).flex_none().child(this.title(t, "Per project · 30 days")).child(this.bars(t, rows));
  }

  modelsSection(t) {
    const rows = this.sum.models.map((m, i) => ({ id: `model-${i}`, label: m.model.replace(/^claude-/, ""), value: m.cost || m.tokens,
      text: m.priced ? `${usd(m.cost)} · ${fmt(m.output)} output` : `${fmt(m.tokens)} tok · unpriced` }));
    return v_flex().gap(8).flex_none().child(this.title(t, "Per model · 30 days")).child(this.bars(t, rows));
  }

  // ---- Agents ----

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [{ k, lines: [...lead, last ? "└" : "├"] }, ...this.tree(all, k.address, [...lead, last ? "" : "│"])];
    });
  }

  agentsSection(t) {
    const list = agents();
    const all = terminals() ?? [];
    const listed = new Set(list.map((a) => a.address));
    const parentOf = new Map(all.map((k) => [k.address, k.parent]));
    // A kept sub-agent is in agents() too: show it under its parent, not twice.
    const tops = list.filter((a) => !listed.has(parentOf.get(a.address)));
    const count = (s) => list.filter((a) => a.status === s).length;
    const chip = (label, n, color) => h_flex().h(22).px(8).gap(5).flex_none().items_center().rounded(11).border_1().border_color("#ffffff14").bg("#ffffff05")
      .child(div().size(6).rounded(3).bg(color)).child(div().text_size(11).text_color(t.muted).child(`${label} ${n}`));
    const dot = (status) => div().size(7).flex_none().rounded(4).bg(AGENT[status] ?? t.dim);
    const rows = [];
    for (const a of tops.slice(0, 8)) {
      rows.push(h_flex().id(`ag-${a.address}`).h(28).px(8).gap(8).items_center().rounded(6)
        .hover((s) => s.bg("#ffffff0d"))
        .on_click(() => run("agent.focus", { terminal: a.address }))
        .child(dot(a.status))
        .child(div().flex_none().font_medium().text_size(12).child(a.program?.name ?? a.app ?? "agent"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${a.space_name} · ${a.title}`)));
      for (const s of this.tree(all, a.address)) {
        const k = s.k;
        const st = list.find((x) => x.address === k.address)?.status ?? (k.status === "error" ? "blocked" : k.status);
        rows.push(h_flex().id(`sub-${k.address}`).h(24).pl(11).pr(8).items_center().rounded(6)
          .hover((s) => s.bg("#ffffff0d"))
          .on_click(() => (listed.has(k.address) ? run("agent.focus", { terminal: k.address }) : run("terminal.peek", { terminal: k.address })))
          .children(s.lines.map((l) => div().self_start().mt(-4).w(9).h(16).mr(4).flex_none()
            .when(Boolean(l), (el) => el.border_l(1.5).border_color("#ffffff2e"))
            .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
          .child(div().mr(8).child(dot(st)))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(k.name || k.template || k.program?.name || k.address)));
      }
    }
    return v_flex().gap(8).flex_none()
      .child(this.title(t, "Agents", String(list.length)))
      .child(h_flex().gap(6).flex_wrap()
        .child(chip("working", count("working"), C.cyan))
        .child(chip("needs you", count("blocked"), C.yellow))
        .child(chip("done", count("done"), C.green))
        .child(chip("idle", count("idle"), t.dim)))
      .child(rows.length ? v_flex().gap(1).children(rows) : div().text_size(11.5).text_color(t.dim).child("No agents running"));
  }
}

// Skills and instruction files for the focused pane's folder, as Claude Code sees them: each
// skill's state (on, name only, only /command, off) in skillOverrides, the same setting Claude
// Code's /skills screen writes, everywhere or for this project; what Claude Code really loads
// and what it costs at the start of every session, from its own /context; uses in the last 30
// days; other agents' skills (read-only); archive and restore. Logic in model.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, theme, home, run, props, appHome, layout, openOverlay, closeOverlay, shared, setShared, nextCommand, checking } from "herdr";
import { STATES, STATE, tilde, scanDisk, claudeContext, readSettings, resolve, denied, applyState, migrateDeny, archive, restore } from "./model.js";

// Panels are glass. Over real blur (the layout's window_blur) a light window behind them
// would wash the text out, so the glass is denser there.
const panelGlass = () => (layout()?.window_blur ? "#16181ddb" : "#14161ba6");

const MOD = "gonnawork-skills";
const REV = "gonnawork-skills.rev"; // bumped by a state change made in the picker popup
const C = { cyan: "#64d2ff", pink: "#ff375f", green: "#30d158", yellow: "#ffd60a", violet: "#bf5af2", red: "#ff453a", orange: "#ff9f0a" };
const STATE_COLOR = { on: C.green, "name-only": C.cyan, "user-invocable-only": C.violet, off: null };
const SOURCE = { project: "Project", user: "User", synced: "claude.ai sync", builtin: "Built-in" };
const CONTROLLED = new Set(["project", "user", "synced", "builtin"]);
const SKILL = new Set(["project", "user", "synced", "builtin", "plugin"]);
const VIEWS = [["all", "All"], ["loaded", "Loaded"], ["unused", "Unused 30d"], ["off", "Off"]];

function sections(t) {
  return [
    { kind: "project", title: "This project", color: C.yellow, hint: ".claude/skills" },
    { kind: "user", title: "Yours", color: C.pink, hint: "~/.claude/skills" },
    { kind: "synced", title: "From claude.ai", color: C.cyan, hint: "synced from your account" },
    { kind: "builtin", title: "Built into Claude Code", color: C.violet, hint: "" },
    { kind: "plugin", title: "Plugins", color: C.orange, hint: "on and off with their plugin (/plugin)" },
    { kind: "instr", title: "Instructions", color: C.green, hint: "always loaded" },
    { kind: "other", title: "Other agents", color: t.dim, hint: "Claude Code doesn't load these" },
    { kind: "archived", title: "Archived", color: t.dim, hint: "~/.claude/skills-archived" },
  ];
}

function fmt(n) {
  n = Math.round(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function clip(text, chars) {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= chars) return s;
  const cut = s.slice(0, chars);
  const at = cut.lastIndexOf(" ");
  return (at > chars * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "") + "…";
}

// Every root-to-node path whose node passes `test`.
function findPaths(node, test, path = [], out = []) {
  if (!node) return out;
  const here = [...path, node];
  if (test(node)) out.push(here);
  for (const child of node.children ?? []) findPaths(child, test, here, out);
  return out;
}

const EMPTY = { user: {}, shared: {}, local: {}, deny: { user: [], local: [] }, bad: [], sync: undefined, noBundled: undefined };

export default class Skills extends View {
  init(_props, cx) {
    this.s = EMPTY;
    this.note = null;
    if (props()?.picker) return this.initPicker(cx);
    this.disk = null;
    this.ctx = null;
    this.ctxAt = 0;
    this.ctxBusy = false;
    this.ctxAgain = false;
    this.ctxError = null;
    this.uses = null;
    this.where = null;
    this.root = null;
    this.cwd = null;
    this.on = null;
    this.sig = "";
    this.rev = shared(REV);
    this.width = 368;
    this.folded = new Set(["archived", "other"]);
    this.filter = "";
    this.view = "all";
    this.detail = null;
    this.dscope = "user";
    this.content = null;
    this.pending = null;
    this.token = 0;
    this.input = InputState.new({ placeholder: "Filter skills…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    if (checking()) return;
    cx.timer.every(30000, (cx) => { if (this.visible()) this.reload(cx); });
    cx.timer.every(300000, (cx) => { if (this.visible()) this.loadContext(cx); });
    cx.timer.every(600000, (cx) => this.loadUses(cx));
    this.loadUses(cx);
    // Keys: gonnawork-skills.refresh. The confirm dialog answers with gonnawork-skills.confirm.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.reload(cx, true);
        else if (c === "confirm") this.confirmed(cx);
        cx.notify();
      }
    });
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

  // The focused pane's folder, else the focused terminal's, else the shown space's.
  location() {
    const space = spaces().find((s) => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return { cwd: pane?.cwd || f?.cwd || space?.folder || home(), on: space?.machine ?? null };
  }

  // Disk and settings; Claude Code's /context again when something it depends on changed.
  reload(cx, force = false) {
    const { cwd, on } = this.location();
    const token = ++this.token;
    cx.spawn(async (cx) => {
      let root = null;
      try {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (r.code === 0) root = r.stdout.trim() || null;
      } catch {}
      let disk = [], s = EMPTY;
      try {
        disk = await scanDisk(cwd, root ?? cwd, on);
        if (!on) s = await readSettings(root, null);
      } catch (e) {
        if (token === this.token) this.note = { text: `Scan failed: ${e?.message ?? e}`, ok: false };
      }
      if (token !== this.token) return;
      const moved = root !== this.root || on !== this.on;
      this.disk = disk;
      this.s = s;
      this.root = root;
      this.cwd = cwd;
      this.on = on;
      if (moved) this.ctx = null;
      if (this.detail) this.detail = this.items().find((i) => i.path === this.detail.path && i.kind === this.detail.kind) ?? null;
      const sig = JSON.stringify([root, on, s.user, s.shared, s.local, s.deny, disk.map((i) => i.path)]);
      if (force || sig !== this.sig) { this.sig = sig; this.loadContext(cx); }
      cx.notify();
    });
  }

  loadContext(cx) {
    if (this.on || !this.cwd) { this.ctx = null; return; }
    if (this.ctxBusy) { this.ctxAgain = true; return; }
    this.ctxBusy = true;
    const dir = this.root ?? this.cwd;
    cx.spawn(async (cx) => {
      try {
        const c = await claudeContext(dir);
        if (dir === (this.root ?? this.cwd)) { this.ctx = c; this.ctxAt = Date.now(); this.ctxError = null; }
      } catch (e) {
        this.ctxError = String(e?.message ?? e);
      }
      this.ctxBusy = false;
      if (this.ctxAgain) { this.ctxAgain = false; this.loadContext(cx); }
      cx.notify();
    });
  }

  loadUses(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [appHome() + `/mods/${MOD}/uses.py`, home() + "/.claude/projects", "30"], { timeout: 60000 });
        if (r.code === 0) this.uses = JSON.parse(r.stdout);
      } catch {}
      cx.notify();
    });
  }

  // On disk, plus what /context lists that has no file here (built in, plugins).
  items() {
    const disk = this.disk ?? [];
    const extra = [];
    for (const k of this.ctx?.skills ?? []) {
      if (k.source === "Built-in") extra.push({ kind: "builtin", name: k.name, keys: [k.name], desc: "", path: `builtin:${k.name}`, bytes: 0 });
      else if (!Object.values(SOURCE).includes(k.source) && !disk.some((i) => i.name === k.name || i.keys?.includes(k.name)))
        extra.push({ kind: "plugin", name: k.name, keys: [k.name], desc: "", path: `plugin:${k.name}`, bytes: 0, plugin: k.source });
    }
    return [...disk, ...extra];
  }

  // What /context says about a skill: its tokens, or which same-named one is loaded instead.
  loaded(item) {
    if (!this.ctx || !SKILL.has(item.kind)) return null;
    const same = this.ctx.skills.filter((k) => k.name === item.name || item.keys?.includes(k.name));
    const mine = same.find((k) => k.source === SOURCE[item.kind]) ?? (item.kind === "plugin" ? same[0] : null);
    if (mine) return { tokens: mine.tokens };
    return { tokens: null, by: same[0]?.source ?? null };
  }

  tokensOf(item) {
    if (item.kind === "instr") {
      const m = this.ctx?.memory.find((x) => x.path === item.path);
      return m ? { tokens: m.tokens, exact: true } : item.agent ? null : { tokens: item.bytes / 4, exact: false };
    }
    if (!SKILL.has(item.kind)) return null;
    const l = this.loaded(item);
    if (l) return l.tokens === null ? { tokens: 0, exact: true, by: l.by } : { tokens: l.tokens, exact: true };
    const st = this.stateOf(item).value;
    const est = st === "on" ? (item.name.length + item.desc.length + 8) / 4 : st === "name-only" ? item.name.length / 4 + 2 : 0;
    return { tokens: est, exact: false };
  }

  usesOf(item) {
    if (!this.uses || !SKILL.has(item.kind)) return null;
    return (item.keys ?? [item.name]).reduce((n, k) => n + (this.uses[k]?.count ?? 0), 0) || (this.uses[item.name]?.count ?? 0);
  }

  stateOf(item) {
    return CONTROLLED.has(item.kind) ? resolve(item, this.s) : { value: "on", scope: null };
  }

  controllable(item) {
    return CONTROLLED.has(item.kind) && !this.on;
  }

  // ---- Changes ----

  flash(text, ok = true) {
    this.note = { text, ok, at: Date.now() };
  }

  set(item, scope, value, cx) {
    cx.spawn(async (cx) => {
      try {
        const s = await readSettings(this.root, null);
        await applyState(item, scope, value, this.root, s);
        this.flash(`${item.name}: ${STATE[value].label}${scope === "project" ? " in this project" : ""}`);
      } catch (e) {
        this.flash(String(e?.message ?? e), false);
      }
      this.reload(cx, true);
      cx.notify();
    });
  }

  ask(pending, title, detail) {
    this.pending = { ...pending, at: Date.now() };
    openOverlay({ mod: "confirm", kind: "dialog", width: 460, height: 210, props: { title, detail, command: { name: `${MOD}.confirm` } } });
  }

  askArchive(item) {
    const repo = item.kind === "project" ? " It's in this repo: git will show it as deleted until you restore it." : "";
    this.ask({ action: "archive", path: item.path }, `Archive ${item.name}?`, `Moves ${tilde(item.dir)} to ~/.claude/skills-archived, so no agent loads it. Restore puts it back.${repo}`);
  }

  askRestore(item) {
    this.ask({ action: "restore", path: item.path }, `Restore ${item.name}?`, `Moves it back to ${tilde(item.origin ?? "?")}.`);
  }

  askMigrate(n) {
    this.ask({ action: "migrate" }, `Turn ${n} skill${n === 1 ? "" : "s"} off properly?`,
      "Replaces each Skill(…) rule in permissions.deny with skillOverrides \"off\", what Claude Code's /skills writes. A deny rule only blocks the call: the skill stays listed and keeps using context. Other deny rules stay as they are.");
  }

  confirmed(cx) {
    const p = this.pending;
    this.pending = null;
    if (!p || Date.now() - p.at > 120000) return;
    const item = this.items().find((i) => i.path === p.path);
    cx.spawn(async (cx) => {
      try {
        if (p.action === "migrate") { await migrateDeny(this.root, this.items()); this.flash("Moved the deny rules to skillOverrides: off"); }
        else if (p.action === "archive" && item) { const to = await archive(item); this.flash(`Archived to ${tilde(to)}`); this.detail = null; }
        else if (p.action === "restore" && item) { const to = await restore(item); this.flash(`Restored to ${tilde(to)}`); this.detail = null; }
      } catch (e) {
        this.flash(String(e?.message ?? e), false);
      }
      this.reload(cx, true);
      cx.notify();
    });
  }

  openPicker(item) {
    openOverlay({ mod: MOD, kind: "popup", width: 330, height: this.root ? 318 : 280,
      props: { picker: { item: { kind: item.kind, name: item.name, keys: item.keys }, root: this.root } } });
  }

  open(item, cx) {
    this.detail = item;
    this.dscope = this.stateOf(item).scope === "local" ? "project" : "user";
    this.content = null;
    this.note = null;
    const on = this.on;
    cx.spawn(async (cx) => {
      const text = item.path.includes(":") && !item.path.startsWith("/") ? "" : await readTextFile(item.path, on ? { on } : undefined).catch(() => null);
      if (this.detail?.path !== item.path) return;
      this.content = (text ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "");
      cx.notify();
    });
    cx.notify();
  }

  // ---- Picker popup (a copy of this mod) ----

  initPicker(cx) {
    const p = props().picker;
    this.item = p.item;
    this.root = p.root;
    this.pscope = "user";
    this.ready = false;
    cx.spawn(async (cx) => {
      try { this.s = await readSettings(this.root, null); } catch {}
      if (resolve(this.item, this.s).scope === "local") this.pscope = "project";
      this.ready = true;
      cx.notify();
    });
  }

  pick(item, scope, value, cx, after) {
    cx.spawn(async (cx) => {
      try {
        const s = await readSettings(this.root, null);
        await applyState(item, scope, value, this.root, s);
        setShared(REV, Date.now());
        after?.();
      } catch (e) {
        this.note = { text: String(e?.message ?? e), ok: false };
      }
      cx.notify();
    });
  }

  pickerView(t) {
    const item = this.item;
    return v_flex().size_full().p(6).gap(4).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().px(6).pt(2).h(22).items_center().gap(6)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(item.name))
        .child(div().text_size(10.5).text_color(t.dim).child("Esc")))
      .child(this.states(t, item, this.pscope, (scope) => { this.pscope = scope; }, (value, cx) =>
        this.pick(item, this.pscope, value, cx, () => closeOverlay(props().overlay))))
      .when(Boolean(this.note), (el) => el.child(div().px(6).text_size(11).text_color(C.red).child(this.note.text)));
  }

  // The four states for one scope (Everywhere / This project), with what each does.
  states(t, item, scope, setScope, choose) {
    const s = this.s;
    const eff = resolve(item, s);
    const userOnly = resolve(item, { user: s.user, shared: {}, local: {} }).value;
    const current = scope === "project" ? eff.value : userOnly;
    const wins = scope === "user" && eff.scope === "local" && eff.value !== userOnly;
    const tab = (id, label) => div().id(`scope-${id}`).flex_1().h(24).flex().items_center().justify_center().rounded(6)
      .text_size(11.5).text_color(scope === id ? t.foreground : t.muted).bg(scope === id ? "#ffffff17" : "#00000000")
      .hover((st) => st.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); setScope(id); cx.notify(); })
      .child(label);
    return v_flex().gap(4)
      .when(Boolean(this.root), (el) => el.child(h_flex().p(2).gap(2).rounded(8).border_1().border_color("#ffffff14").bg("#00000033")
        .child(tab("user", "Everywhere")).child(tab("project", "This project"))))
      .children(STATES.map((v) => {
        const on = current === v;
        const color = STATE_COLOR[v] ?? t.muted;
        return h_flex().id(`st-${v}`).px(8).py(6).gap(9).items_center().rounded(7).border_1()
          .border_color(on ? color + "66" : "#00000000").bg(on ? color + "14" : "#00000000")
          .hover((st) => st.bg(on ? color + "1f" : "#ffffff0a"))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); if (!on) choose(v, cx); })
          .child(div().size(10).flex_none().rounded(5).border_1().border_color(on ? color : t.dim).when(on, (el) => el.bg(color)))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(12.5).font_medium().text_color(on ? t.foreground : t.muted).child(STATE[v].label))
            .child(div().text_size(10.5).text_color(t.dim).child(STATE[v].hint)));
      }))
      .when(wins, (el) => el.child(div().px(6).text_size(10.5).text_color(C.yellow).child(`This project sets it to ${STATE[eff.value].label}, which wins here.`)))
      .when(scope === "project", (el) => el.child(div().px(6).text_size(10.5).text_color(t.dim).child("Saved in .claude/settings.local.json, which stays out of git.")));
  }

  // ---- Main view ----

  render(cx) {
    const t = theme();
    if (props()?.picker) return this.pickerView(t);
    const loc = this.location();
    const where = `${loc.on}|${loc.cwd}`;
    if (where !== this.where) { this.where = where; if (!checking()) this.reload(cx); }
    const rev = shared(REV);
    if (rev !== this.rev) { this.rev = rev; this.reload(cx, true); }
    if (this.note && this.note.at && Date.now() - this.note.at > 6000) this.note = null;
    const root = v_flex().id("skills-root").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(panelGlass()).border_1().border_color("#ffffff14").text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); } });
    return root.child(this.detail ? this.detailView(t) : this.listView(t));
  }

  header(t, pill) {
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color("#ffffff14")
      .child(svg(`mods/${MOD}/skill.svg`).size(15).flex_none().text_color(C.yellow))
      .child(div().font_semibold().child("Skills"))
      .when(Boolean(pill), (el) => el.child(div().px(6).h(18).flex().items_center().rounded(9).border_1().border_color("#ffffff1a").text_size(10).text_color(t.muted).truncate().child(pill)))
      .child(div().flex_1())
      .child(div().id("reload").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover((s) => s.bg("#ffffff0f").text_color(C.yellow))
        .on_click((_e, cx) => { this.reload(cx, true); this.loadUses(cx); })
        .child("↻"));
  }

  noteBar(t) {
    const color = this.note.ok ? C.green : C.red;
    return div().mx(10).mt(8).px(8).py(5).rounded(6).bg(color + "10").text_size(11).text_color(color).child(this.note.text);
  }

  // What Claude Code loads when a session starts here, from its own /context.
  summary(t) {
    const c = this.ctx;
    const box = v_flex().mx(10).mt(8).px(10).py(8).gap(6).flex_none().rounded(8).border_1().border_color("#ffffff0d").bg("#ffffff05");
    if (this.on) return box.child(div().text_size(11).text_color(t.dim).child(`On ${this.on}: read-only here. States and costs come from Claude Code on this computer.`));
    const status = this.ctxBusy
      ? h_flex().gap(5).items_center().child(div().text_color(C.yellow).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child("checking")
      : div().child(c ? `checked ${ago(this.ctxAt)}` : "");
    const title = h_flex().gap(6).items_center()
      .child(div().flex_1().text_size(10).font_semibold().text_color(t.dim).child("CLAUDE CODE LOADS AT START"))
      .child(div().text_size(10.5).text_color(t.dim).child(status));
    if (!c) return box.child(title).child(div().text_size(11).text_color(this.ctxError ? C.red : t.dim)
      .child(this.ctxError ? `Couldn't ask Claude Code: ${this.ctxError}` : "Asking Claude Code (/context, no model call)…"));
    const stat = (label, value, color) => v_flex().flex_1().min_w(0).gap(1)
      .child(div().text_size(10).text_color(t.dim).truncate().child(label))
      .child(div().text_size(14).font_semibold().text_color(color).truncate().child(value));
    // Claude Code sends the skill list as a message of its own at the first turn: /context
    // shows it as a slice of "System tools" and leaves it out of its total, so add it back.
    const start = (c.total ?? 0) + (c.skillsTotal ?? 0);
    const pct = c.window ? Math.min(1, start / c.window) : 0;
    return box.child(title)
      .child(h_flex().gap(10)
        .child(stat("Skills", `~${fmt(c.skillsTotal)} tok`, C.yellow))
        .child(stat("CLAUDE.md", `~${fmt(c.memoryTotal)} tok`, C.green))
        .child(stat("Whole start", c.window ? `${fmt(start)} / ${fmt(c.window)}` : `~${fmt(start)}`, C.cyan)))
      .child(div().h(3).w_full().rounded(2).bg("#ffffff0a").child(div().h(3).rounded(2).bg(C.cyan).w(Math.max(2, (this.width - 42) * pct))));
  }

  listView(t) {
    const items = this.items();
    const q = this.filter.trim().toLowerCase();
    const st = new Map(items.map((i) => [i, this.stateOf(i)]));
    const isLoaded = (i) => { const l = this.loaded(i); return this.ctx ? Boolean(l && l.tokens !== null) : ["on", "name-only"].includes(st.get(i).value); };
    const isUnused = (i) => CONTROLLED.has(i.kind) && ["on", "name-only"].includes(st.get(i).value) && this.usesOf(i) === 0;
    const isOff = (i) => SKILL.has(i.kind) && !isLoaded(i);
    const test = { all: () => true, loaded: (i) => SKILL.has(i.kind) && isLoaded(i), unused: isUnused, off: isOff }[this.view];
    const shown = items.filter((i) => test(i) && (!q || [i.name, i.plugin ?? "", i.desc, i.agent ?? ""].some((s) => s.toLowerCase().includes(q))));
    const skills = items.filter((i) => SKILL.has(i.kind));
    const loadedN = skills.filter(isLoaded).length;
    const pill = this.ctx ? `${loadedN} loaded · ~${fmt(this.ctx.skillsTotal)} tok` : `${skills.length} skills`;
    const counts = { all: items.length, loaded: loadedN, unused: items.filter(isUnused).length, off: items.filter(isOff).length };
    const chars = Math.max(40, Math.floor((this.width - 44) / 6.1) * 2);

    // Skills still turned off the old way: listed, using context.
    const rules = [...new Set([...this.s.deny.user, ...this.s.deny.local])];
    const legacy = items.filter((i) => CONTROLLED.has(i.kind) && denied(i, this.s));
    const legacyTok = legacy.reduce((n, i) => n + (this.loaded(i)?.tokens ?? 0), 0);

    let n = 0;
    const off = { synced: this.s.sync === false ? "sync is off here (syncClaudeAiSkills)" : null, builtin: this.s.noBundled === true ? "off here (disableBundledSkills)" : null };
    const secs = sections(t).map((sec) => {
      const list = shown.filter((i) => i.kind === sec.kind);
      if (off[sec.kind]) sec = { ...sec, hint: off[sec.kind] };
      if (!list.length) return null;
      const folded = this.folded.has(sec.kind) && !q;
      return v_flex().gap(6).flex_none()
        .child(h_flex().id(`sec-${sec.kind}`).gap(6).items_center().h(22)
          .on_click((_e, cx) => { this.folded.has(sec.kind) ? this.folded.delete(sec.kind) : this.folded.add(sec.kind); cx.notify(); })
          .child(div().w(10).text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
          .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child(sec.title.toUpperCase()))
          .child(div().text_size(10.5).text_color(sec.color).child(String(list.length)))
          .child(div().flex_1().h(1).bg("#ffffff0f"))
          .when(Boolean(sec.hint) && this.width > 300, (el) => el.child(div().flex_none().max_w(170).truncate().text_size(10).text_color(t.dim).child(sec.hint))))
        .when(!folded, (el) => el.children(list.map((item) => this.card(t, item, sec.color, n++, chars))));
    }).filter(Boolean);

    const empty = this.disk === null ? "Looking for skills…" : !shown.length ? (q || this.view !== "all" ? "Nothing matches" : "No skills for this folder") : null;
    const chip = ([id, label]) => h_flex().id(`view-${id}`).h(22).px(8).gap(4).flex_none().items_center().rounded(11).border_1()
      .border_color(this.view === id ? "#ffffff33" : "#ffffff12").bg(this.view === id ? "#ffffff12" : "#00000000")
      .text_size(11).text_color(this.view === id ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.view = id; cx.notify(); })
      .child(label).child(div().text_size(10.5).text_color(t.dim).child(String(counts[id])));

    return v_flex().flex_1().min_h(0)
      .child(this.header(t, pill))
      .child(div().px(10).pt(10).flex_none().child(
        div().id("filter").h(30).px(10).flex().items_center().rounded(8).border_1().border_color("#ffffff14").bg("#00000033")
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground))))
      .child(h_flex().px(10).pt(8).gap(5).flex_none().flex_wrap().children(VIEWS.map(chip)))
      .when(Boolean(this.note), (el) => el.child(this.noteBar(t)))
      .when(this.s.bad.length > 0, (el) => el.child(div().mx(10).mt(8).px(8).py(5).rounded(6).bg(C.red + "10").text_size(11).text_color(C.red)
        .child(`${this.s.bad.map(tilde).join(", ")} isn't valid JSON: states can't be read or changed until it's fixed`)))
      .when(rules.length > 0 && !this.on, (el) => el.child(v_flex().mx(10).mt(8).px(10).py(8).gap(6).flex_none().rounded(8).border_1().border_color(C.yellow + "55").bg(C.yellow + "0d")
        .child(div().text_size(11.5).text_color(t.foreground).child(`${rules.length} skill${rules.length === 1 ? " is" : "s are"} turned off with permissions.deny.`))
        .child(div().text_size(11).text_color(t.muted).child(legacyTok
          ? `That only blocks the call: Claude still lists ${rules.length === 1 ? "it" : "them"} here and loads ~${fmt(legacyTok)} tok every session.`
          : `That only blocks the call: wherever ${rules.length === 1 ? "it loads" : "they load"}, Claude still lists ${rules.length === 1 ? "it" : "them"} and pays the context.`))
        .child(h_flex().child(this.pill(t, "migrate", "Turn off properly", C.yellow, true, () => this.askMigrate(rules.length))))))
      .child(this.summary(t))
      .child(v_flex().id("skills-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
        .children(secs)
        .when(Boolean(empty), (el) => el.child(div().py(30).flex().justify_center().text_size(12).text_color(t.dim).child(empty))));
  }

  // The state chip: opens the picker on skills the panel can change.
  chip(t, item, i) {
    const st = this.stateOf(item);
    const color = STATE_COLOR[st.value] ?? t.dim;
    const can = this.controllable(item);
    return h_flex().id(`chip-${i}`).h(20).px(7).gap(4).flex_none().items_center().rounded(10).border_1()
      .border_color(color + "66").bg(color + "14").text_size(10.5).text_color(color)
      .when(can, (el) => el.hover((s) => s.bg(color + "26"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.openPicker(item); }))
      .child(STATE[st.value].label)
      .when(st.scope === "local" || st.scope === "shared", (el) => el.child(div().text_size(9.5).text_color(t.dim).child("here")))
      .when(can, (el) => el.child(div().text_size(8).text_color(t.dim).child("▾")));
  }

  card(t, item, color, i, chars) {
    const st = this.stateOf(item);
    const tok = this.tokensOf(item);
    const uses = this.usesOf(item);
    const dim = SKILL.has(item.kind) && (tok?.exact ? tok.tokens === 0 : !["on", "name-only"].includes(st.value));
    const icon = item.kind === "instr" ? "doc" : "skill";
    const old = CONTROLLED.has(item.kind) && denied(item, this.s);
    const meta = [
      uses === null ? null : uses ? `×${uses} in 30d` : "unused in 30d",
      tok?.by ? `${tok.by} one loads instead` : null,
      old ? "old deny rule" : null,
      item.kind === "synced" && this.s.sync === false ? "not synced into sessions here" : null,
      item.kind === "archived" ? `from ${tilde(item.origin ?? "?")}` : null,
      item.kind === "instr" ? tilde(item.path) : null,
    ].filter(Boolean).join(" · ");
    const tokText = !tok ? null : tok.exact ? (tok.tokens ? `~${fmt(tok.tokens)} tok` : "not loaded") : `≈${fmt(tok.tokens)} tok`;
    return v_flex().id(`card-${i}`).flex_none().px(10).py(8).gap(4).rounded(8).border_1().border_color("#ffffff0d").bg("#ffffff05")
      .hover((s) => s.bg("#ffffff0f").border_color("#ffffff26"))
      .on_click((_e, cx) => this.open(item, cx))
      .child(h_flex().gap(7).items_center()
        .child(svg(`mods/${MOD}/${icon}.svg`).size(14).flex_none().text_color(dim ? t.dim : color))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(dim ? t.muted : t.foreground).child(item.plugin && item.kind === "plugin" ? `${item.plugin}:${item.name}` : item.name))
        .when(Boolean(item.agent), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color("#ffffff1a").text_size(10).text_color(t.muted).child(item.agent)))
        .when(Boolean(tokText), (el) => el.child(div().flex_none().text_size(10.5).text_color(tok.exact && tok.tokens ? t.muted : t.dim).child(tokText)))
        .when(SKILL.has(item.kind) && item.kind !== "plugin", (el) => el.child(this.chip(t, item, i))))
      .when(Boolean(item.desc), (el) => el.child(div().text_size(11.5).text_color(dim ? t.dim : t.muted).child(clip(item.desc, chars))))
      .when(Boolean(meta), (el) => el.child(div().text_size(10.5).truncate().text_color(old ? C.yellow : t.dim).child(meta)));
  }

  pill(t, id, label, color, solid, action) {
    return div().id(id).h(22).px(8).flex().flex_none().items_center().rounded(6).border_1().border_color("#ffffff1a")
      .text_size(11).text_color(color).when(solid, (el) => el.bg(color + "22"))
      .hover((s) => s.bg(color + "22"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label);
  }

  detailView(t) {
    const item = this.detail;
    const st = this.stateOf(item);
    const tok = this.tokensOf(item);
    const uses = this.usesOf(item);
    const file = item.path.startsWith("/");
    const color = sections(t).find((s) => s.kind === item.kind)?.color ?? C.yellow;
    const pills = [];
    if (file) {
      pills.push(this.pill(t, "read", "Read", C.violet, false, () =>
        run("pane.split", { direction: "right", argv: ["sh", "-c", 'command -v glow >/dev/null && exec glow -p "$1" || exec less "$1"', "sh", item.path] })));
      pills.push(this.pill(t, "edit", "Open", C.cyan, false, () =>
        run("pane.split", { direction: "right", argv: ["sh", "-c", 'exec ${EDITOR:-vi} "$1"', "sh", item.path] })));
    }
    if (!this.on && (item.kind === "project" || item.kind === "user")) pills.push(this.pill(t, "archive", "Archive", C.red, false, () => this.askArchive(item)));
    if (!this.on && item.kind === "archived") pills.push(this.pill(t, "restore", "Restore", C.green, true, () => this.askRestore(item)));
    const facts = [
      tok ? (tok.exact ? (tok.tokens ? `~${fmt(tok.tokens)} tok at every start (Claude Code)` : "Claude Code doesn't load it") : `≈${fmt(tok.tokens)} tok at start (estimated)`) : null,
      SKILL.has(item.kind) && item.bytes ? `~${fmt(item.bytes / 4)} tok when it runs` : null,
      uses === null ? null : uses ? `used ${uses}× in 30 days` : "not used in 30 days",
    ].filter(Boolean).join(" · ");
    const why = {
      synced: "Synced from your Claude account. Removing the files just brings them back; change its state instead.",
      builtin: "Comes with Claude Code: no file here. Its state works like any other skill's.",
      plugin: "Comes from a plugin: it goes on and off with the plugin (/plugin). skillOverrides doesn't apply to it.",
      other: `${item.agent ?? "Another agent"} reads this. Claude Code doesn't load it, so it's read-only here.`,
      instr: item.agent ? `${item.agent} reads this file.` : "Claude Code reads it whole at the start of every session here.",
      archived: "Archived: no agent loads it. Restore puts it back where it was.",
    }[item.kind];
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(42).flex_none().px(10).gap(8).items_center().border_b(1).border_color("#ffffff14")
        .child(div().id("back").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .hover((s) => s.bg("#ffffff0f").text_color(t.foreground))
          .on_click((_e, cx) => { this.detail = null; this.note = null; cx.notify(); }).child("←"))
        .child(svg(`mods/${MOD}/${item.kind === "instr" ? "doc" : "skill"}.svg`).size(14).flex_none().text_color(color))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(item.kind === "plugin" && item.plugin ? `${item.plugin}:${item.name}` : item.name))
        .when(SKILL.has(item.kind) && item.kind !== "plugin", (el) => el.child(div().flex_none().text_size(10.5).text_color(STATE_COLOR[st.value] ?? t.dim).child(STATE[st.value].label))))
      .child(v_flex().id("skill-detail").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(12).pt(10).gap(8).flex_none()
          .when(file, (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(tilde(item.path))))
          .when(Boolean(facts), (el) => el.child(div().text_size(11).text_color(t.muted).child(facts)))
          .when(Boolean(why), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(why)))
          .when(this.controllable(item), (el) => el.child(v_flex().gap(4).p(6).rounded(8).border_1().border_color("#ffffff0d").bg("#ffffff05")
            .child(this.states(t, item, this.dscope, (scope) => { this.dscope = scope; }, (value, cx) => this.set(item, this.dscope, value, cx)))))
          .when(pills.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(pills))))
        .when(Boolean(this.note), (el) => el.child(this.noteBar(t)))
        .child(div().p(12).text_size(12.5)
          .child(!file ? div().text_color(t.dim).child("No file to show.")
            : this.content === null ? div().text_color(t.dim).child("Loading…")
            : TextView.markdown(`md-${item.path}`, this.content || "_(empty)_"))));
  }
}

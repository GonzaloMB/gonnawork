// Skills and instruction files (SKILL.md, CLAUDE.md, AGENTS.md...) that apply to the
// focused pane's folder: read, disable, enable and remove them. With props {view: "stats"}
// the same mod is the Stats panel: agents (with their sub-agents as a tree), fixed context,
// skill uses and tokens per project from Claude Code's transcripts (usage.py), and the live
// session of each agent in the shown space (hc get → pid → ~/.claude/sessions/<pid>.json).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, theme, home, run, props, agents, appHome, terminals, hc } from "herdr";

const C = { cyan: "#64d2ff", pink: "#ff375f", green: "#30d158", yellow: "#ffd60a", violet: "#bf5af2", red: "#ff453a" };

// Prints kind\0path\0bytes\0frontmatter\0 for every skill and instruction file.
const SCRIPT = `emit() { printf '%s\\0%s\\0%s\\0' "$1" "$2" "$(wc -c < "$2" | tr -d ' ')"; sed -n '1,60p' "$2" | awk 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} NR>1{print}'; printf '\\0'; }
scan() { [ -d "$2" ] || return 0; find -L "$2" -maxdepth "$3" -name SKILL.md -not -path '*/marketplaces/*' -not -path '*/node_modules/*' -not -path '*/skills-removed/*' 2>/dev/null | sort | while IFS= read -r f; do emit "$1" "$f"; done; }
cwd=$1; top=$2; d=$cwd
while [ "$d" != "$HOME" ]; do
  for s in .claude/skills .agents/skills .codex/skills .opencode/skills .opencode/skill .cursor/skills; do scan project "$d/$s" 3; done
  for m in CLAUDE.md CLAUDE.local.md AGENTS.md .claude/CLAUDE.md GEMINI.md; do [ -f "$d/$m" ] && emit instr "$d/$m"; done
  if [ "$d" = "$top" ] || [ "$d" = / ] || [ "$d" = "$HOME" ]; then break; fi
  d=$(dirname "$d")
done
for s in "$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.codex/skills" "$HOME/.config/opencode/skills"; do scan user "$s" 4; done
[ -f "$HOME/.claude/CLAUDE.md" ] && emit uinstr "$HOME/.claude/CLAUDE.md"
[ -f "$HOME/.codex/AGENTS.md" ] && emit uinstr "$HOME/.codex/AGENTS.md"
scan plugin "$HOME/.claude/plugins" 9
true`;

const SECTIONS = [
  { kind: "project", title: "Project", color: C.yellow },
  { kind: "instr", title: "Project instructions", color: C.cyan },
  { kind: "plugin", title: "Plugins", color: C.violet },
  { kind: "user", title: "Global (user)", color: C.pink },
  { kind: "uinstr", title: "Global instructions", color: C.green },
];
const STATUS = { working: C.cyan, blocked: C.yellow, done: C.green };

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p) => p.replace(/\/+$/, "").split("/").pop();

function tilde(p) {
  const h = home();
  return p === h ? "~" : p?.startsWith(h + "/") ? "~" + p.slice(h.length) : p ?? "";
}

function fmt(n) {
  n = Math.round(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

// key: value, with | and > blocks, quotes removed.
function parseFrontmatter(text) {
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let v = m[2].trim();
    if (/^[|>][+-]?$/.test(v)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i].trim());
      v = v[0] === "|" ? block.join("\n").trim() : block.join(" ").replace(/\s+/g, " ").trim();
    }
    out[m[1]] = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return out;
}

function makeItem(kind, path, bytes, fm) {
  const meta = parseFrontmatter(fm);
  const parts = path.split("/");
  const instr = kind === "instr" || kind === "uinstr";
  const file = parts[parts.length - 1];
  const name = instr ? (parts[parts.length - 2] === ".claude" ? ".claude/" + file : file) : meta.name || parts[parts.length - 2];
  let plugin = null;
  if (kind === "plugin") {
    const i = parts.lastIndexOf("skills");
    let j = i - 1;
    if (j > 0 && /^v?\d+(\.\d+)*$/.test(parts[j])) j--;
    if (j >= 0) plugin = parts[j];
  }
  const desc = meta.description || "";
  const size = Number(bytes) || 0;
  return {
    kind, path, name, plugin, desc, instr,
    rule: plugin ? `${plugin}:${name}` : name,
    bytes: size,
    tokens: Math.round(size / 4),
    descBytes: instr ? size : desc.length + name.length + 8,
    synced: path.includes("/skills/synced/"),
    target: instr ? path : dirname(path),
  };
}

function denied(text) {
  const out = new Set();
  try {
    for (const r of JSON.parse(text)?.permissions?.deny ?? []) {
      const m = /^Skill\((.+)\)$/.exec(r);
      if (m) out.add(m[1]);
    }
  } catch {}
  return out;
}

function clip(text, chars) {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= chars) return s;
  const cut = s.slice(0, chars);
  const at = cut.lastIndexOf(" ");
  return (at > chars * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "") + "…";
}

export default class Skills extends View {
  init() {
    this.stats = props()?.view === "stats";
    this.items = null;
    this.where = null;
    this.root = null;
    this.on = null;
    this.deny = { global: new Set(), project: new Set() };
    this.width = 368;
    this.folded = new Set();
    this.filter = "";
    this.detail = null;
    this.content = null;
    this.confirm = null;
    this.note = null;
    this.usage = null;
    this.usageError = null;
    this.live = {};
    this.liveKey = null;
    this.token = 0;
    this.input = InputState.new({ placeholder: "Filter skills…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
  }

  // The focused pane's folder, else the focused terminal's, else the shown space's.
  location() {
    const space = spaces().find((s) => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return { cwd: pane?.cwd || f?.cwd || space?.folder || home(), on: space?.machine ?? null };
  }

  reload(cx) {
    const { cwd, on } = this.location();
    const token = ++this.token;
    cx.spawn(async (cx) => {
      let root = null;
      try {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (r.code === 0) root = r.stdout.trim() || null;
      } catch {}
      const top = root ?? cwd;
      let items = [];
      try {
        const r = await exec("sh", ["-c", SCRIPT, "skills", cwd, top], { on });
        const f = r.stdout.split("\0");
        const seen = new Set();
        for (let i = 0; i + 3 < f.length; i += 4) {
          const kind = f[i].replace(/^\n+/, ""), path = f[i + 1];
          if (!kind || !path || seen.has(path)) continue;
          seen.add(path);
          items.push(makeItem(kind, path, f[i + 2], f[i + 3]));
        }
      } catch (e) {
        if (token === this.token) this.note = { text: `Scan failed: ${e}`, ok: false };
      }
      const global = await readTextFile(home() + "/.claude/settings.json").catch(() => null);
      const project = root && !on ? await readTextFile(root + "/.claude/settings.local.json").catch(() => null) : null;
      if (token !== this.token) return;
      this.items = items;
      this.root = root;
      this.on = on;
      this.deny = { global: denied(global ?? ""), project: denied(project ?? "") };
      if (this.detail) this.detail = items.find((i) => i.path === this.detail.path) ?? null;
      cx.notify();
    });
  }

  loadUsage(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [appHome() + "/mods/skills/usage.py", home() + "/.claude/projects", "30"], { timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
        this.usage = JSON.parse(r.stdout);
        this.usageError = null;
      } catch (e) {
        this.usageError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  off(item) {
    if (item.instr) return null;
    if (this.deny.global.has(item.rule)) return "global";
    if (this.deny.project.has(item.rule)) return "project";
    return null;
  }

  // Changes only permissions.deny, as a set; leaves a file that isn't valid JSON alone.
  async setDeny(path, rule, add) {
    const before = await readTextFile(path);
    let obj = {};
    if (before !== null && before.trim()) {
      try { obj = JSON.parse(before); } catch { throw new Error(`${tilde(path)} isn't valid JSON; left it alone`); }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${tilde(path)} isn't a JSON object; left it alone`);
    if (!obj.permissions || typeof obj.permissions !== "object" || Array.isArray(obj.permissions)) obj.permissions = {};
    const set = new Set(Array.isArray(obj.permissions.deny) ? obj.permissions.deny : []);
    const r = `Skill(${rule})`;
    if (add) set.add(r); else set.delete(r);
    obj.permissions.deny = [...set];
    await exec("mkdir", ["-p", dirname(path)]);
    await writeTextFile(path, JSON.stringify(obj, null, 2) + "\n", before);
  }

  change(item, scope, add, cx) {
    const path = scope === "global" ? home() + "/.claude/settings.json" : this.root + "/.claude/settings.local.json";
    cx.spawn(async (cx) => {
      try {
        await this.setDeny(path, item.rule, add);
        this.note = { text: `${add ? "Disabled" : "Enabled"} ${item.rule} ${scope === "global" ? "globally" : "in this project"}`, ok: true };
      } catch (e) {
        this.note = { text: String(e?.message ?? e), ok: false };
      }
      this.reload(cx);
      cx.notify();
    });
  }

  // The switch: on turns it off globally; off turns it back on where it was turned off.
  flip(item, cx) {
    const off = this.off(item);
    if (!off) return this.change(item, "global", true, cx);
    if (this.deny.global.has(item.rule)) this.change(item, "global", false, cx);
    if (this.deny.project.has(item.rule) && this.root && !this.on) this.change(item, "project", false, cx);
  }

  removable(item) {
    return !item.synced && item.kind !== "plugin" && !this.on;
  }

  remove(item, cx) {
    if (this.confirm !== item.path) { this.confirm = item.path; cx.notify(); return; }
    this.confirm = null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "");
    const dest = `${home()}/.claude/skills-removed/${item.name.replace(/[/:]/g, "_")}-${stamp}`;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && mv "$1" "$2"', "sh", item.target, dest]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
        this.note = { text: `Moved to ${tilde(dest)}`, ok: true };
        this.detail = null;
      } catch (e) {
        this.note = { text: `Couldn't remove: ${e?.message ?? e}`, ok: false };
      }
      this.reload(cx);
      cx.notify();
    });
  }

  open(item, cx) {
    this.detail = item;
    this.content = null;
    this.confirm = null;
    this.note = null;
    const on = this.on;
    cx.spawn(async (cx) => {
      const text = await readTextFile(item.path, { on }).catch(() => null);
      if (this.detail?.path !== item.path) return;
      this.content = (text ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "");
      cx.notify();
    });
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const loc = this.location();
    const where = `${loc.on}|${loc.cwd}`;
    if (where !== this.where) {
      const first = this.where === null;
      this.where = where;
      if (first) {
        cx.timer.every(30000, (cx) => this.reload(cx));
        if (this.stats) {
          this.loadUsage(cx);
          cx.timer.every(120000, (cx) => this.loadUsage(cx));
          cx.timer.every(15000, (cx) => this.loadLive(cx));
        }
      }
      this.reload(cx);
    }
    if (this.stats) {
      const key = this.spaceAgents().map((a) => a.address).join(",") + "|" + spaces().find((s) => s.active)?.id;
      if (key !== this.liveKey) { this.liveKey = key; this.loadLive(cx); }
    }
    const root = v_flex().id("skills-root").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg("#14161ba6").border_1().border_color("#ffffff14").text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); } });
    if (this.stats) return root.child(this.header(t, "Stats", "stats.svg", C.cyan, null)).child(this.statsView(t));
    if (this.detail) return root.child(this.detailView(t));
    return root.child(this.listView(t));
  }

  header(t, title, icon, color, pill) {
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color("#ffffff14")
      .child(svg(`mods/skills/${icon}`).size(15).flex_none().text_color(color))
      .child(div().font_semibold().child(title))
      .when(Boolean(pill), (el) => el.child(div().px(6).h(18).flex().items_center().rounded(9).border_1().border_color("#ffffff1a").text_size(10).text_color(t.muted).truncate().child(pill)))
      .child(div().flex_1())
      .child(div().id("reload").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover((s) => s.bg("#ffffff0f").text_color(color))
        .on_click((_e, cx) => { this.reload(cx); if (this.stats) this.loadUsage(cx); })
        .child("↻"));
  }

  noteBar(t) {
    if (!this.note) return null;
    const color = this.note.ok ? C.green : C.red;
    return div().mx(10).mt(8).px(8).py(5).rounded(6).bg(color + "10").text_size(11).text_color(color).child(this.note.text);
  }

  listView(t) {
    const items = this.items ?? [];
    const q = this.filter.trim().toLowerCase();
    const shown = q ? items.filter((i) => [i.name, i.plugin ?? "", i.desc].some((s) => s.toLowerCase().includes(q))) : items;
    const inProject = items.filter((i) => i.kind === "project").length;
    const skills = items.filter((i) => !i.instr);
    const off = skills.filter((i) => this.off(i)).length;
    const pill = `${inProject} in project · ${skills.length} total · ${off} off`;
    const chars = Math.max(40, Math.floor((this.width - 44) / 6.1) * 2);
    let n = 0;
    const sections = SECTIONS.map((sec) => {
      const list = shown.filter((i) => i.kind === sec.kind);
      if (!list.length) return null;
      const folded = this.folded.has(sec.kind);
      return v_flex().gap(6).flex_none()
        .child(h_flex().id(`sec-${sec.kind}`).gap(6).items_center().h(22)
          .on_click((_e, cx) => { folded ? this.folded.delete(sec.kind) : this.folded.add(sec.kind); cx.notify(); })
          .child(div().w(10).text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
          .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(sec.title.toUpperCase()))
          .child(div().text_size(10.5).text_color(sec.color).child(String(list.length)))
          .child(div().flex_1().h(1).bg("#ffffff0f")))
        .when(!folded, (el) => el.children(list.map((item) => this.card(t, item, sec.color, n++, chars))));
    }).filter(Boolean);
    const empty = !items.length ? (this.items === null ? "Looking for skills…" : "No skills for this folder") : !shown.length ? "Nothing matches" : null;
    return v_flex().flex_1().min_h(0)
      .child(this.header(t, "Skills", "skill.svg", C.yellow, pill))
      .child(div().px(10).pt(10).flex_none().child(
        div().id("filter").h(30).px(10).flex().items_center().rounded(8).border_1().border_color("#ffffff14").bg("#00000033")
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground))))
      .when(Boolean(this.note), (el) => el.child(this.noteBar(t)))
      .child(v_flex().id("skills-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
        .when(this.items !== null && items.length > 0 && !inProject && !q, (el) => el.child(
          div().px(10).py(7).rounded(8).border_1().border_color("#ffffff0d").text_size(11).text_color(t.dim)
            .child("This project has no skills of its own (.claude/skills, .agents/skills…)")))
        .children(sections)
        .when(Boolean(empty), (el) => el.child(div().py(30).flex().justify_center().text_size(12).text_color(t.dim).child(empty))));
  }

  card(t, item, color, i, chars) {
    const off = this.off(item);
    return v_flex().id(`card-${i}`).flex_none().px(10).py(8).gap(4).rounded(8).border_1().border_color("#ffffff0d").bg("#ffffff05")
      .hover((s) => s.bg("#ffffff0f").border_color("#ffffff26"))
      .when(Boolean(off), (el) => el.opacity(0.45))
      .on_click((_e, cx) => this.open(item, cx))
      .child(h_flex().gap(7).items_center()
        .child(svg(`mods/skills/${item.instr ? "doc" : "skill"}.svg`).size(14).flex_none().text_color(color))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(item.plugin ? `${item.plugin}:${item.name}` : item.name))
        .when(Boolean(off), (el) => el.child(div().flex_none().text_size(10.5).text_color(C.yellow).child(off === "global" ? "off" : "off here")))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${fmt(item.tokens)} tok`))
        .when(!item.instr, (el) => el.child(this.switch(t, item, !off, i))))
      .when(Boolean(item.desc), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(clip(item.desc, chars))));
  }

  switch(t, item, on, i) {
    return h_flex().id(`sw-${i}`).w(28).h(16).flex_none().px(2).items_center().rounded(8).border_1()
      .border_color(on ? C.green + "88" : "#ffffff1f").bg(on ? C.green + "33" : "#ffffff10")
      .when(on, (el) => el.justify_end())
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.flip(item, cx); })
      .child(div().size(10).rounded(5).bg(on ? C.green : t.dim));
  }

  pill(t, id, label, color, solid, action) {
    return div().id(id).h(22).px(8).flex().flex_none().items_center().rounded(6).border_1().border_color("#ffffff1a")
      .text_size(11).text_color(color).when(solid, (el) => el.bg(color + "22"))
      .hover((s) => s.bg(color + "22"))
      .on_click(action).child(label);
  }

  detailView(t) {
    const item = this.detail;
    const off = this.off(item);
    const remote = Boolean(this.on);
    const pills = [];
    if (!item.instr) {
      pills.push(this.deny.global.has(item.rule)
        ? this.pill(t, "en-global", "Enable (global)", C.green, true, (_e, cx) => this.change(item, "global", false, cx))
        : this.pill(t, "dis-global", "Disable globally", C.yellow, false, (_e, cx) => this.change(item, "global", true, cx)));
      if (this.root && !remote) pills.push(this.deny.project.has(item.rule)
        ? this.pill(t, "en-proj", "Enable in project", C.green, true, (_e, cx) => this.change(item, "project", false, cx))
        : this.pill(t, "dis-proj", "Disable in this project", C.yellow, false, (_e, cx) => this.change(item, "project", true, cx)));
    }
    pills.push(this.pill(t, "read", "Read", C.violet, false, () =>
      run("pane.split", { direction: "right", argv: ["sh", "-c", 'command -v glow >/dev/null && exec glow -p "$1" || exec less "$1"', "sh", item.path] })));
    pills.push(this.pill(t, "open", "Open", C.cyan, false, () =>
      run("pane.split", { direction: "right", argv: ["sh", "-c", 'exec ${EDITOR:-vi} "$1"', "sh", item.path] })));
    if (this.removable(item)) pills.push(this.pill(t, "remove", this.confirm === item.path ? "Sure? Click again" : "Remove", C.red, this.confirm === item.path, (_e, cx) => this.remove(item, cx)));
    const color = SECTIONS.find((s) => s.kind === item.kind)?.color ?? C.yellow;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(42).flex_none().px(10).gap(8).items_center().border_b(1).border_color("#ffffff14")
        .child(div().id("back").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .hover((s) => s.bg("#ffffff0f").text_color(t.foreground))
          .on_click((_e, cx) => { this.detail = null; this.confirm = null; this.note = null; cx.notify(); }).child("←"))
        .child(svg(`mods/skills/${item.instr ? "doc" : "skill"}.svg`).size(14).flex_none().text_color(color))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(item.plugin ? `${item.plugin}:${item.name}` : item.name))
        .when(Boolean(off), (el) => el.child(div().flex_none().text_size(10.5).text_color(C.yellow).child(off === "global" ? "off" : "off here")))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${fmt(item.tokens)} tok when loaded`)))
      .child(v_flex().px(12).pt(10).gap(8).flex_none()
        .child(div().text_size(11).text_color(t.dim).truncate().child(tilde(item.path)))
        .child(h_flex().gap(6).flex_wrap().children(pills))
        .when(item.synced, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("Synced from your Claude account: you can disable it, but removing it just brings it back.")))
        .when(item.kind === "plugin", (el) => el.child(div().text_size(10.5).text_color(t.dim).child("Comes from a plugin: disable it here or uninstall the plugin with /plugin."))))
      .when(Boolean(this.note), (el) => el.child(this.noteBar(t)))
      .child(div().id("skill-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).text_size(12.5)
        .child(this.content === null
          ? div().text_color(t.dim).child("Loading…")
          : TextView.markdown(`md-${item.path}`, this.content || "_(empty)_")));
  }

  // ---- Stats ----

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
          const r = await exec("python3", [appHome() + "/mods/skills/usage.py", "--live", home() + "/.claude/projects", ...args], { timeout: 30000 });
          data = JSON.parse(r.stdout);
        } catch {}
      }
      this.live = Object.fromEntries(list.map((a) => [a.address, specs[a.address] ? data[specs[a.address]] ?? null : null]));
      cx.notify();
    });
  }

  sessionCard(t, a, perRow) {
    const s = this.live[a.address];
    const claude = a.app === "claude-code" || a.program?.key === "claude";
    const head = h_flex().gap(8).items_center()
      .child(div().size(7).flex_none().rounded(4).bg(STATUS[a.status] ?? t.dim))
      .child(div().flex_none().font_medium().text_size(12.5).child(a.program?.name ?? a.app ?? "agent"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(a.title))
      .when(Boolean(s?.model), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color("#ffffff1a")
        .text_size(10).text_color(t.muted).child(s.model.replace(/^claude-/, ""))));
    const card = v_flex().id(`sess-${a.address}`).flex_none().p(10).gap(8).rounded(10).border_1()
      .border_color(a.focused ? "#ffffff26" : "#ffffff0d").bg("#ffffff05").hover((st) => st.bg("#ffffff0a"))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(head);
    if (!claude || s === null) return card.child(div().text_size(11).text_color(t.dim).child(claude ? "No transcript for this session yet" : "Only Claude Code sessions have transcripts"));
    if (s === undefined) return card.child(div().text_size(11).text_color(t.dim).child("Reading session…"));
    const total = s.input + s.cache_create + s.cache_read + s.output;
    const mins = s.started ? Math.max(0, Math.round((Date.now() - Date.parse(s.started)) / 60000)) : null;
    const ago = mins === null ? null : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
    const tiles = [
      this.tile(t, "Context now", `${fmt(s.context)} tok`, C.cyan, null, true),
      this.tile(t, "Session tokens", fmt(total), C.violet, `${fmt(s.cache_read)} from cache`, true),
      this.tile(t, "Output", fmt(s.output), C.green, null, true),
      this.tile(t, "Turns", String(s.turns), C.yellow, ago ? `running ${ago}` : null, true),
    ];
    const used = Object.entries(s.skills).sort((x, y) => y[1] - x[1]);
    return card.children(this.grid(tiles, perRow))
      .when(used.length > 0, (el) => el.child(h_flex().gap(5).flex_wrap().items_center()
        .child(div().text_size(10.5).text_color(t.dim).child("Skills used:"))
        .children(used.map(([n, c]) => div().px(6).h(18).flex().items_center().rounded(9).bg(C.pink + "22").text_size(10.5).text_color(C.pink).child(`${n} ×${c}`)))));
  }

  grid(tiles, perRow) {
    const rows = [];
    for (let i = 0; i < tiles.length; i += perRow) rows.push(h_flex().gap(8).children(tiles.slice(i, i + perRow)));
    return rows;
  }

  usesOf(item) {
    const s = this.usage?.skills ?? {};
    return (s[item.rule]?.count ?? 0) || (item.plugin ? s[item.name]?.count ?? 0 : 0);
  }

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
    const dot = (status) => div().size(7).flex_none().rounded(4).bg(STATUS[status] ?? t.dim);
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
      .child(this.sectionTitle(t, "Agents", list.length))
      .child(h_flex().gap(6).flex_wrap()
        .child(chip("working", count("working"), C.cyan))
        .child(chip("needs you", count("blocked"), C.yellow))
        .child(chip("done", count("done"), C.green))
        .child(chip("idle", count("idle"), t.dim)))
      .child(rows.length ? v_flex().gap(1).children(rows) : div().text_size(11.5).text_color(t.dim).child("No agents running"));
  }

  sectionTitle(t, title, n) {
    return h_flex().gap(6).items_center().h(20)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(title.toUpperCase()))
      .when(n !== undefined, (el) => el.child(div().text_size(10.5).text_color(t.muted).child(String(n))))
      .child(div().flex_1().h(1).bg("#ffffff0f"));
  }

  tile(t, label, value, color, hint, compact = false) {
    return v_flex().h(compact ? 64 : 84).p(compact ? 8 : 10).gap(compact ? 2 : 4).min_w(0).flex_1().rounded(10).border_1().border_color("#ffffff0d").bg("#ffffff05")
      .child(div().text_size(10).text_color(t.dim).truncate().child(label.toUpperCase()))
      .child(div().text_size(compact ? 16 : 19).font_semibold().text_color(color).truncate().child(value))
      .when(Boolean(hint), (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(hint)));
  }

  bars(t, title, rows, color, show, limit = 8) {
    const top = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, limit);
    const max = top[0]?.value || 1;
    const inner = Math.max(60, this.width - 46);
    return v_flex().gap(7).flex_none()
      .child(this.sectionTitle(t, title))
      .child(top.length
        ? v_flex().gap(7).children(top.map((r) => v_flex().gap(3)
          .child(h_flex().gap(8).text_size(11.5)
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.label))
            .child(div().flex_none().text_color(color).child(show(r.value))))
          .child(div().h(3).w_full().rounded(2).bg("#ffffff0a")
            .child(div().h(3).rounded(2).bg(color).w(Math.max(2, inner * r.value / max))))))
        : div().text_size(11.5).text_color(t.dim).child("Nothing yet"));
  }

  statsView(t) {
    const items = this.items ?? [];
    const skills = items.filter((i) => !i.instr);
    const active = skills.filter((i) => !this.off(i));
    const fixed = active.reduce((n, i) => n + i.descBytes / 4, 0) + items.filter((i) => i.instr).reduce((n, i) => n + i.bytes / 4, 0);
    const uses = skills.reduce((n, i) => n + this.usesOf(i), 0);
    const root = this.root ?? this.location().cwd;
    const projects = this.usage?.projects ?? [];
    const total = (p) => p.input + p.cache_create + p.cache_read + p.output;
    const here = projects.filter((p) => p.cwd && (p.cwd === root || p.cwd.startsWith(root + "/")));
    const hereTokens = here.reduce((n, p) => n + total(p), 0);
    const sessions = here.reduce((n, p) => n + p.sessions, 0);
    const output = here.reduce((n, p) => n + p.output, 0);
    const label = (i) => (i.plugin ? `${i.plugin}:${i.name}` : i.name);
    const perRow = this.width > 760 ? 4 : this.width > 330 ? 2 : 1;
    const projectTiles = [
      this.tile(t, "Active skills", `${active.length}/${skills.length}`, C.green),
      this.tile(t, "Fixed context", `~${fmt(fixed)} tok`, C.yellow, "loaded in every session"),
      this.tile(t, "Project tokens · 30d", this.usage ? fmt(hereTokens) : "…", C.cyan, this.usage ? (sessions ? `${sessions} sessions · ${fmt(output)} output` : "no Claude sessions here") : null),
    ];
    const allTokens = projects.reduce((n, p) => n + total(p), 0);
    const allSessions = projects.reduce((n, p) => n + p.sessions, 0);
    const allOutput = projects.reduce((n, p) => n + p.output, 0);
    const globalTiles = [
      this.tile(t, "Tokens · 30 days", this.usage ? fmt(allTokens) : "…", C.violet, this.usage ? `${fmt(allOutput)} output` : null),
      this.tile(t, "Sessions · 30 days", this.usage ? fmt(allSessions) : "…", C.cyan, this.usage ? `${projects.length} projects` : null),
      this.tile(t, "Skill uses · 30 days", this.usage ? fmt(uses) : "…", C.pink),
    ];
    const mine = this.spaceAgents();
    const tok = (v) => `${fmt(v)} tok`;
    return v_flex().id("stats-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(16)
      .child(v_flex().gap(8).flex_none()
        .child(this.sectionTitle(t, "This space", mine.length))
        .children(mine.length ? mine.map((a) => this.sessionCard(t, a, perRow)) : [div().text_size(11.5).text_color(t.dim).child("No agent running in this space")]))
      .child(v_flex().gap(8).flex_none()
        .child(this.sectionTitle(t, `Project · ${basename(root) || "~"}`))
        .children(this.grid(projectTiles, perRow > 1 ? Math.min(perRow, 3) : 1)))
      .child(v_flex().gap(8).flex_none()
        .child(this.sectionTitle(t, "Global · 30 days"))
        .children(this.grid(globalTiles, perRow > 1 ? Math.min(perRow, 3) : 1)))
      .child(this.agentsSection(t))
      .when(Boolean(this.usageError), (el) => el.child(div().text_size(11).text_color(C.red).child(`Usage: ${this.usageError}`)))
      .child(this.bars(t, "Most used (30 days)", skills.map((i) => ({ label: label(i), value: this.usesOf(i) })), C.pink, (v) => `${v}×`))
      .child(this.bars(t, "Estimated spend (uses × size)", skills.map((i) => ({ label: label(i), value: this.usesOf(i) * i.tokens })), C.red, tok))
      .child(this.bars(t, "Heaviest when loaded", items.map((i) => ({ label: label(i), value: i.tokens })), C.yellow, tok))
      .child(this.bars(t, "Fixed context per skill (description)", active.map((i) => ({ label: label(i), value: Math.round(i.descBytes / 4) })), C.violet, tok))
      .child(this.bars(t, "Tokens per project (30 days)", projects.map((p) => ({ label: p.cwd ? tilde(p.cwd) : p.id, value: total(p) })), C.cyan, fmt, 6))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child("Tokens estimated as bytes/4. Uses: Skill tool calls and /skill commands in ~/.claude/projects."));
  }
}

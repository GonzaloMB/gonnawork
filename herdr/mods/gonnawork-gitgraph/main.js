// Git history of the repos open in the shown space, with colored lanes like VS Code's
// Git Graph. Read only: the only thing that changes anything is Fetch (remote branches).
// Rows are virtualized by hand (gpui's virtual lists didn't paint inside this panel).

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, home, layout } from "herdr";

// Panels are glass. Over real blur (the layout's window_blur) a light window behind them
// would wash the text out, so the glass is denser there.
const panelGlass = () => (layout()?.window_blur ? "#16181ddb" : "#14161ba6");

const LANES = ["#0a84ff", "#ff375f", "#30d158", "#ff9f0a", "#bf5af2", "#64d2ff", "#ffd60a", "#5e5ce6", "#ff453a", "#ac8e68"];
const ROW = 24, LANE = 11, PAD = 10, MAX_LANES = 11;
const laneX = (i) => PAD + i * LANE;
const color = (i) => LANES[i % LANES.length];
const C = { cyan: "#64d2ff", green: "#30d158", yellow: "#ffd60a", red: "#ff453a" };
const STALE = 45000, FETCH_STALE = 150000;

function layoutGraph(commits) {
  let lanes = [], width = 1;
  const rows = [];
  for (const c of commits) {
    const before = lanes.slice();
    let col = before.indexOf(c.hash);
    if (col < 0) { col = before.indexOf(null); if (col < 0) col = before.length; }
    const top = [];
    before.forEach((h, j) => { if (h) top.push({ from: j, to: h === c.hash ? col : j, lane: j }); });
    const next = before.map((h) => (h === c.hash ? null : h));
    while (next.length <= col) next.push(null);
    const bottom = [];
    next.forEach((h, j) => { if (h) bottom.push({ from: j, to: j, lane: j }); });
    c.parents.forEach((p, k) => {
      let target = next.indexOf(p);
      if (k === 0 && target < 0) { next[col] = p; target = col; }
      else if (target < 0) { target = next.indexOf(null); if (target < 0) target = next.length; next[target] = p; }
      bottom.push({ from: col, to: target, lane: k === 0 ? col : target });
    });
    while (next.length && next[next.length - 1] === null) next.pop();
    lanes = next;
    width = Math.max(width, col + 1, lanes.length);
    rows.push({ ...c, col, top, bottom });
  }
  return { rows, width: Math.min(width, MAX_LANES) };
}

function tilde(p) {
  const h = home();
  return p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

// %D: "HEAD -> main, origin/main, tag: v1". A local branch and its remote copies on the
// same commit become one chip: the branch, then its remotes.
function parseRefs(text, remotes) {
  const out = [];
  const locals = new Map();
  const remoteRefs = [];
  for (const raw of text.split(", ").map((s) => s.trim()).filter(Boolean)) {
    if (raw === "HEAD") { out.push({ kind: "head", name: "HEAD", head: true, remotes: [] }); continue; }
    if (raw.startsWith("HEAD -> ")) {
      const r = { kind: "branch", name: raw.slice(8), head: true, remotes: [] };
      locals.set(r.name, r); out.push(r); continue;
    }
    if (raw.startsWith("tag: ")) { out.push({ kind: "tag", name: raw.slice(5), head: false, remotes: [] }); continue; }
    if (raw.endsWith("/HEAD")) continue;
    const slash = raw.indexOf("/");
    if (slash > 0 && remotes.includes(raw.slice(0, slash))) { remoteRefs.push({ remote: raw.slice(0, slash), branch: raw.slice(slash + 1), full: raw }); continue; }
    const r = { kind: "branch", name: raw, head: false, remotes: [] };
    locals.set(raw, r); out.push(r);
  }
  for (const r of remoteRefs) {
    const local = locals.get(r.branch);
    if (local) local.remotes.push(r.remote);
    else out.push({ kind: "remote", name: r.full, head: false, remotes: [] });
  }
  // HEAD's own chip first.
  return out.sort((a, b) => Number(b.head) - Number(a.head));
}

const GIT = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

// The repositories in the direct children of `dir`: clones inside a repo (gitignored
// checkouts, submodules), or the projects in a folder like ~/code. Not deeper.
async function childRepos(dir, on) {
  const sub = await exec("sh", ["-c", 'find "$1" -mindepth 2 -maxdepth 2 -name .git 2>/dev/null | sort | head -60', "sh", dir], { on, timeout: 10000 });
  return sub.stdout.split("\n").filter(Boolean).map((g) => g.replace(/\/\.git$/, ""));
}

// The main checkout of the repository at `root`: `root` itself unless it is a linked worktree.
async function mainCheckout(root, on) {
  const r = await exec("git", [...GIT, "worktree", "list", "--porcelain"], { cwd: root, on, timeout: 10000 });
  return (r.code === 0 && /^worktree (.+)$/m.exec(r.stdout)?.[1]) || root;
}

function track(text) {
  const a = /ahead (\d+)/.exec(text ?? ""), b = /behind (\d+)/.exec(text ?? "");
  return [a ? `↑${a[1]}` : "", b ? `↓${b[1]}` : ""].filter(Boolean).join(" ");
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.repos = [];
    this.repo = null;
    this.on = null;
    this.space = null;
    this.sig = null;
    this.rows = [];
    this.lanes = 1;
    this.branches = [];
    this.remotes = [];
    this.head = null;
    this.headBranch = null;
    this.headTrack = "";
    this.loaded = false;
    this.state = "searching"; // searching | none | norepo | ready
    this.busy = { discover: 0, refresh: 0, fetch: 0 };
    this.again = { discover: false, refresh: false };
    this.token = 0;
    this.scroll = 0;
    this.bodyH = 300;
    this.size = { width: 368, height: 600 };
    this.selected = null;
    this.show = null;
    this.menu = null;
    this.filterBranch = null;
    this.showRemote = localStorage.getItem("remote") !== "false";
    this.note = null;
    this.watching = null;
    this.branchQuery = "";
    this.branchInput = InputState.new({ placeholder: "Search branches…" });
    this.branchInput.on("change", (_e, cx) => { this.branchQuery = this.branchInput.value(); cx.notify(); });
    cx.timer.every(15000, (cx) => this.discover(cx));
  }

  git(args, opts = {}) {
    return exec("git", [...GIT, ...args], { cwd: this.repo, on: this.on, ...opts });
  }

  // One run at a time per job; a call during a run repeats it once at the end.
  // A run older than `stale` counts as lost so the flag can't block forever.
  guard(name, cx, job, stale = STALE) {
    if (this.busy[name] && Date.now() - this.busy[name] < stale) { this.again[name] = true; return; }
    this.busy[name] = Date.now();
    this.again[name] = false;
    cx.spawn(async (cx) => {
      try {
        await job(cx);
      } catch (e) {
        this.note = { text: `${name}: ${e?.message ?? e}`, ok: false };
      } finally {
        this.busy[name] = 0;
      }
      cx.notify();
      if (this.again[name]) { this.again[name] = false; this.guard(name, cx, job, stale); }
    });
  }

  signature() {
    const space = spaces().find((s) => s.active);
    if (!space) return "";
    const tabs = new Set(space.tabs.map((t) => t.id));
    const f = focused();
    const fp = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const ps = panes().filter((p) => tabs.has(p.tab)).map((p) => `${p.cwd}@${p.branch}`).join(",");
    return `${space.id}|${fp?.cwd ?? f?.cwd ?? ""}|${ps}`;
  }

  discover(cx) {
    this.guard("discover", cx, async (cx) => {
      const space = spaces().find((s) => s.active);
      if (!space) { this.repos = []; this.setRepo(null, cx); return; }
      const tabs = new Set(space.tabs.map((t) => t.id));
      const f = focused();
      const fp = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
      const first = fp?.cwd ?? (tabs.has(f?.tab) ? f?.cwd : null);
      const dirs = [];
      if (first) dirs.push(first);
      for (const p of panes()) if (tabs.has(p.tab) && p.cwd && !dirs.includes(p.cwd)) dirs.push(p.cwd);
      if (!dirs.length && space.folder) dirs.push(space.folder);
      const on = space.machine ?? null;
      const found = [];
      const nested = [];
      const scanned = new Set();
      const scan = async (dir) => { if (!scanned.has(dir)) { scanned.add(dir); nested.push(...await childRepos(dir, on)); } };
      for (const [i, d] of dirs.entries()) {
        try {
          const r = await exec("git", [...GIT, "rev-parse", "--show-toplevel"], { cwd: d, on, timeout: 10000 });
          const root = r.code === 0 ? r.stdout.trim() : "";
          if (root && !found.some((x) => x.root === root)) {
            found.push({ root, focused: i === 0 && d === first });
            // The repos cloned inside it; a linked worktree has none: its main checkout's.
            await scan(root);
            await scan(await mainCheckout(root, on));
          }
          if (!root && d !== home() && d !== "/") await scan(d);
        } catch {}
      }
      for (const root of nested) if (!found.some((x) => x.root === root)) found.push({ root, focused: false });
      if (spaces().find((s) => s.active)?.id !== space.id) { this.again.discover = true; return; }
      this.repos = found;
      this.on = on;
      this.space = space.id;
      this.state = found.length ? "ready" : dirs.length ? "norepo" : "none";
      const kept = localStorage.getItem(`repo:${space.id}`);
      const pick = found.find((x) => x.root === kept)?.root ?? found[0]?.root ?? null;
      this.setRepo(pick, cx);
    });
  }

  setRepo(root, cx) {
    if (root === this.repo) { if (root) this.refresh(cx); return; }
    this.repo = root;
    this.token++;
    this.rows = []; this.branches = []; this.head = null; this.headBranch = null; this.headTrack = "";
    this.loaded = false; this.scroll = 0; this.selected = null; this.show = null; this.filterBranch = null; this.note = null;
    if (root) { this.refresh(cx); this.watch(root, cx); }
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watching === root) return;
    this.watching = root;
    cx.spawn(async (cx) => {
      while (this.repo === root) {
        try { await watchFolder(root + "/.git"); } catch { break; }
        if (this.repo !== root) break;
        this.refresh(cx);
      }
      if (this.watching === root) this.watching = null;
    });
  }

  refresh(cx) {
    this.guard("refresh", cx, async (cx) => {
      const root = this.repo, token = this.token;
      if (!root) return;
      const [rem, refs, head] = await Promise.all([
        this.git(["remote"]),
        this.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:track)", "refs/heads", "refs/remotes"]),
        this.git(["rev-parse", "HEAD"]),
      ]);
      if (token !== this.token) return;
      const remotes = rem.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      const branches = [];
      for (const line of refs.stdout.split("\n").filter(Boolean)) {
        const [full, short, mark, tr] = line.split("\x1f");
        if (short.endsWith("/HEAD") || remotes.includes(short)) continue;
        branches.push({ name: short, remote: full.startsWith("refs/remotes/"), head: mark === "*", track: track(tr) });
      }
      const scope = this.filterBranch ? [this.filterBranch] : this.showRemote ? ["--all"] : ["--branches", "--tags", "HEAD"];
      const log = await this.git(["log", ...scope, "--topo-order", "--max-count=800", "--date=format:%d %b %Y %H:%M",
        "--format=%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ad%x1e"]);
      if (token !== this.token) return;
      const commits = [];
      if (log.code === 0) {
        for (const rec of log.stdout.split("\x1e")) {
          const f = rec.replace(/^\s+/, "").split("\x1f");
          if (f.length < 6 || !f[0]) continue;
          commits.push({ hash: f[0], parents: f[1] ? f[1].split(" ").filter(Boolean) : [], refs: parseRefs(f[2], remotes), subject: f[3], author: f[4], date: f[5] });
        }
      }
      const g = layoutGraph(commits);
      const hb = branches.find((b) => b.head);
      this.remotes = remotes;
      this.branches = branches;
      this.head = head.code === 0 ? head.stdout.trim() : null;
      this.headBranch = hb?.name ?? null;
      this.headTrack = hb?.track ?? "";
      this.rows = g.rows;
      this.lanes = g.width;
      this.loaded = true;
      if (this.selected && !g.rows.some((r) => r.hash === this.selected)) { this.selected = null; this.show = null; }
      cx.notify();
    });
  }

  fetch(cx) {
    this.guard("fetch", cx, async (cx) => {
      const token = this.token;
      let r;
      try { r = await this.git(["fetch", "--all", "--prune"], { timeout: 120000 }); }
      catch (e) { r = { code: 1, stderr: String(e) }; }
      if (token !== this.token) return;
      this.note = r.code === 0 ? { text: "Fetched all remotes", ok: true } : { text: r.stderr.trim().split("\n").pop() || "Fetch failed", ok: false };
      this.refresh(cx);
    }, FETCH_STALE);
  }

  select(row, cx) {
    if (this.selected === row.hash) { this.selected = null; this.show = null; cx.notify(); return; }
    this.selected = row.hash;
    this.show = null;
    const token = this.token;
    cx.spawn(async (cx) => {
      const r = await this.git(["show", "--stat=70", "--format=%an <%ae>%n%ad%n%n%B", "--date=format:%d %b %Y %H:%M", row.hash]).catch((e) => ({ stdout: String(e) }));
      if (token !== this.token || this.selected !== row.hash) return;
      this.show = r.stdout.split("\n").slice(0, 80).join("\n");
      cx.notify();
    });
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const sig = this.signature();
    if (sig !== this.sig) { this.sig = sig; this.discover(cx); }
    const loading = Boolean(this.busy.discover || this.busy.refresh || this.busy.fetch);
    const root = v_flex().id("gitgraph-root").relative().size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(panelGlass()).border_1().border_color("#ffffff12").text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(this.toolbar(t, loading))
      .when(Boolean(this.note), (el) => el.child(div().mx(10).mb(6).px(8).py(4).rounded(6).text_size(11)
        .bg((this.note.ok ? C.green : C.red) + "10").text_color(this.note.ok ? C.green : C.red).child(this.note.text)));
    const empty = this.emptyText();
    if (empty) return root.child(div().flex_1().flex().items_center().justify_center().text_color(t.dim).child(empty)).when(Boolean(this.menu), (el) => el.child(this.menuView(t)));
    return root.child(this.columns(t)).child(this.body(t))
      .when(Boolean(this.selected), (el) => el.child(this.detail(t)))
      .when(Boolean(this.menu), (el) => el.child(this.menuView(t)));
  }

  emptyText() {
    if (this.state === "searching" && !this.repo) return "Loading history…";
    if (this.state === "none") return "No git repository open in this space";
    if (this.state === "norepo" || !this.repo) return "No git repository found";
    if (!this.loaded) return "Loading history…";
    if (!this.rows.length) return "No commits yet";
    return null;
  }

  branchLabel() {
    if (this.headBranch) return this.headBranch;
    if (this.head) return this.loaded ? `detached ${this.head.slice(0, 7)}` : this.knownBranch() ?? `detached ${this.head.slice(0, 7)}`;
    return this.knownBranch();
  }

  // While git answers: the branch Herdr already knows for a pane in this repo.
  knownBranch() {
    if (!this.repo) return null;
    return panes().find((p) => p.cwd && (p.cwd === this.repo || p.cwd.startsWith(this.repo + "/")) && p.branch)?.branch ?? null;
  }

  toolbar(t, loading) {
    const stop = (_e, cx) => cx.stop_propagation();
    const tool = (id, label, tip, action) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color("#c4c8d0").hover((s) => s.bg("#ffffff14").text_color(C.cyan)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(action).child(label);
    const branch = this.branchLabel();
    const repoName = this.repo ? this.repo.split("/").pop() : "—";
    const drop = (id, label, value, open) => h_flex().gap(6).items_center().min_w(0)
      .child(div().flex_none().text_size(11.5).font_semibold().text_color("#d8dbe2").child(label))
      .child(h_flex().id(id).h(24).px(8).gap(6).min_w(0).items_center().rounded(6).border_1()
        .border_color(open ? C.cyan + "88" : "#ffffff1f").bg("#00000040")
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.menu = this.menu === id ? null : id; if (this.menu === "branches") { this.branchInput.set_value(""); this.branchQuery = ""; } cx.notify(); })
        .child(div().min_w(0).max_w(150).truncate().child(value))
        .child(div().flex_none().text_size(9).text_color(t.dim).child(open ? "▲" : "▼")));
    return v_flex().flex_none().px(10).pb(8).gap(4)
      .child(h_flex().h(38).gap(8).items_center()
        .child(svg("mods/gonnawork-gitgraph/git.svg").size(15).flex_none().text_color(t.muted))
        .child(div().flex_none().font_semibold().text_color("#ffffff").child("Git Graph"))
        .when(Boolean(branch), (el) => el.child(h_flex().h(20).px(7).gap(5).min_w(0).items_center().rounded(10)
          .bg(C.green + "1f").border_1().border_color(C.green + "55").text_size(11)
          .child(div().flex_none().text_color(C.green).child("⑂"))
          .child(div().min_w(0).truncate().text_color(C.green).child(branch))
          .when(Boolean(this.headTrack), (el) => el.child(div().flex_none().text_color(C.yellow).child(this.headTrack)))))
        .child(div().flex_1())
        .when(loading, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(C.cyan).spin(900)))
        .child(tool("fetch", "⇣", "Fetch from all remotes", (_e, cx) => this.fetch(cx)))
        .child(tool("refresh", "↻", "Refresh", (_e, cx) => { this.discover(cx); this.refresh(cx); })))
      .child(h_flex().gap(12).items_center().flex_wrap()
        .child(drop("repos", "Repo:", repoName, this.menu === "repos"))
        .child(drop("branches", "Branches:", this.filterBranch ?? "Show All", this.menu === "branches"))
        .child(h_flex().id("remote-toggle").gap(6).items_center().flex_none().on_mouse_down("left", stop)
          .on_click((_e, cx) => { this.showRemote = !this.showRemote; localStorage.setItem("remote", String(this.showRemote)); this.refresh(cx); cx.notify(); })
          .child(div().size(14).flex().items_center().justify_center().rounded(3).border_1()
            .border_color(this.showRemote ? C.cyan : "#ffffff40").bg(this.showRemote ? C.cyan : "#00000000")
            .text_size(10).font_bold().text_color("#000000").child(this.showRemote ? "✓" : ""))
          .child(div().text_size(11.5).text_color("#d8dbe2").child("Show Remote Branches"))));
  }

  shownLanes() {
    return Math.min(this.lanes, this.size.width < 520 ? 6 : MAX_LANES);
  }

  graphWidth() {
    return Math.max(56, laneX(this.shownLanes() - 1) + PAD);
  }

  cols() {
    const rest = this.size.width - this.graphWidth();
    return { date: rest > 360, author: rest > 520, commit: rest > 640 };
  }

  columns(t) {
    const c = this.cols();
    return h_flex().h(24).flex_none().px(0).items_center().bg("#ffffff06").text_size(11).font_semibold().text_color("#c4c8d0")
      .child(div().w(this.graphWidth()).flex_none().pl(8).child("Graph"))
      .child(div().flex_1().min_w(0).pl(4).child("Description"))
      .when(c.date, (el) => el.child(div().w(118).flex_none().child("Date")))
      .when(c.author, (el) => el.child(div().w(120).flex_none().child("Author")))
      .when(c.commit, (el) => el.child(div().w(66).flex_none().child("Commit")))
      .child(div().w(10).flex_none());
  }

  body(t) {
    const total = this.rows.length * ROW;
    const max = Math.max(0, total - this.bodyH);
    if (this.scroll > max) this.scroll = max;
    const first = Math.max(0, Math.floor(this.scroll / ROW));
    const count = Math.ceil(this.bodyH / ROW) + 1;
    const visible = this.rows.slice(first, first + count);
    const thumbH = total > this.bodyH ? Math.max(24, this.bodyH * this.bodyH / total) : 0;
    const thumbTop = max ? (this.bodyH - thumbH) * this.scroll / max : 0;
    return div().id("gg-body").relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => { if (Math.abs(size.height - this.bodyH) >= 1) { this.bodyH = size.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        const next = Math.min(max, Math.max(0, this.scroll - e.delta.y));
        if (next !== this.scroll) { this.scroll = next; cx.notify(); }
      })
      .children(visible.map((r, i) => this.row(t, r, first + i).absolute().left(0).right(0).top((first + i) * ROW - this.scroll)))
      .when(thumbH > 0, (el) => el.child(div().absolute().right(1).w(5).rounded(3).bg("#ffffff2e").top(thumbTop).h(thumbH)));
  }

  graphCell(r) {
    const n = this.shownLanes();
    const w = this.graphWidth();
    const mid = ROW / 2;
    const segs = [];
    const add = (s, y1, y2) => {
      if (s.from >= n || s.to >= n) return;
      const x1 = laneX(s.from), x2 = laneX(s.to);
      const p = PathBuilder.stroke(1.8).move_to(x1, y1);
      if (x1 === x2) p.line_to(x2, y2);
      else p.cubic_bezier_to(x2, y2, x1, y1 + (y2 - y1) * 0.9, x2, y1 + (y2 - y1) * 0.1);
      segs.push(window.paint_path(p.build(), color(s.lane)).absolute().top(0).left(0).w(w).h(ROW));
    };
    for (const s of r.top) add(s, 0, mid);
    for (const s of r.bottom) add(s, mid, ROW);
    const cell = div().relative().w(w).h(ROW).flex_none().children(segs);
    if (r.col >= n) return cell;
    const x = laneX(r.col), c = color(r.col);
    const isHead = r.hash === this.head;
    return cell.child(isHead
      ? div().absolute().left(x - 6).top(mid - 6).size(12).rounded(6).border(2).border_color(c).bg("#1c1c1e")
      : div().absolute().left(x - 4).top(mid - 4).size(8).rounded(4).bg(c));
  }

  chip(ref, c) {
    const glyph = ref.kind === "tag" ? "⌂" : ref.kind === "remote" ? "☁" : "⑂";
    return h_flex().h(18).flex_none().rounded(4).overflow_hidden().items_center()
      .when(ref.head, (el) => el.border_1().border_color(c))
      .child(div().size(16).flex_none().flex().items_center().justify_center().bg(c).text_size(10).text_color("#000000").child(glyph))
      .child(h_flex().h_full().px(5).gap(4).items_center().bg("#ffffff0a").text_size(11)
        .child(div().max_w(120).truncate().when(ref.head, (el) => el.font_bold().text_color("#ffffff")).child(ref.name))
        .when(ref.remotes.length > 0, (el) => el.child(div().text_size(10).text_color("#8e8e93").child(ref.remotes.join(" ")))));
  }

  row(t, r, i) {
    const c = this.cols();
    const isHead = r.hash === this.head;
    const merge = r.parents.length > 1;
    const lc = color(r.col);
    const mono = settings().font_family || settings().font || "JetBrains Mono";
    return h_flex().id(`gg-row-${r.hash}`).h(ROW).items_center()
      .when(this.selected === r.hash, (el) => el.bg("#ffffff14"))
      .hover((s) => s.bg("#ffffff0a"))
      .on_click((_e, cx) => this.select(r, cx))
      .child(this.graphCell(r))
      .child(h_flex().flex_1().min_w(0).pl(4).gap(5).items_center()
        .children(r.refs.slice(0, 2).map((ref) => this.chip(ref, lc)))
        .when(r.refs.length > 2, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${r.refs.length - 2}`)))
        .child(div().flex_1().min_w(0).truncate().text_color(merge ? t.dim : isHead ? "#ffffff" : t.foreground).child(r.subject)))
      .when(c.date, (el) => el.child(div().w(118).flex_none().truncate().text_color(t.dim).child(r.date)))
      .when(c.author, (el) => el.child(div().w(120).flex_none().truncate().text_color(t.dim).child(r.author)))
      .when(c.commit, (el) => el.child(div().w(66).flex_none().font_family(mono).text_size(11).text_color(t.dim).child(r.hash.slice(0, 8))))
      .child(div().w(10).flex_none());
  }

  detail(t) {
    const r = this.rows.find((x) => x.hash === this.selected);
    const mono = settings().font_family || settings().font || "JetBrains Mono";
    return v_flex().h(240).flex_none().bg("#00000059").border_t(1).border_color("#ffffff14")
      .child(h_flex().h(30).flex_none().px(10).gap(8).items_center()
        .child(div().flex_none().font_family(mono).text_size(11).text_color(C.yellow).child(this.selected.slice(0, 10)))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(r?.subject ?? ""))
        .child(div().id("gg-close").size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .hover((s) => s.bg("#ffffff14").text_color(t.foreground))
          .on_click((_e, cx) => { this.selected = null; this.show = null; cx.notify(); }).child("✕")))
      .child(div().id("gg-show").flex_1().min_h(0).overflow_y_scrollbar().px(10).pb(10)
        .font_family(mono).text_size(10.5).text_color(t.muted)
        .child(this.show === null ? "Loading…" : v_flex().children(this.show.split("\n").map((l) => div().min_h(14).child(l || " ")))));
  }

  menuView(t) {
    const box = v_flex().id("gg-menu").absolute().top(72).left(10).w(Math.min(340, this.size.width - 20)).max_h(Math.max(160, this.size.height - 90))
      .p(4).gap(1).rounded(8).border_1().border_color("#ffffff1f").bg("#0b0d11f0").text_size(12)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_scroll_wheel((_e, cx) => cx.stop_propagation());
    const item = (id, el, action) => h_flex().id(id).h(26).px(8).gap(8).flex_none().items_center().rounded(5)
      .hover((s) => s.bg("#ffffff14")).on_click(action).child(el);
    if (this.menu === "repos") {
      return box.children(this.repos.length ? this.repos.map((r, i) => item(`gg-repo-${i}`,
        h_flex().gap(8).items_center().min_w(0).flex_1()
          .child(div().w(12).flex_none().text_color(C.green).child(r.root === this.repo ? "✓" : ""))
          .child(div().flex_none().child(r.root.split("/").pop()))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(tilde(r.root)))
          .when(r.focused, (el) => el.child(div().flex_none().text_size(10.5).text_color(C.cyan).child("focused"))),
        (_e, cx) => { this.menu = null; if (this.space) localStorage.setItem(`repo:${this.space}`, r.root); this.setRepo(r.root, cx); }))
        : [div().p(8).text_color(t.dim).child("No repositories")]);
    }
    const q = this.branchQuery.trim().toLowerCase();
    const list = this.branches.filter((b) => !q || b.name.toLowerCase().includes(q));
    const pick = (name) => (_e, cx) => { this.menu = null; this.filterBranch = name; this.scroll = 0; this.selected = null; this.show = null; this.refresh(cx); cx.notify(); };
    return box
      .child(div().id("gg-bsearch").h(28).px(8).mb(4).flex().flex_none().items_center().rounded(6).border_1().border_color(C.cyan + "55")
        .cursor_text().child(Input.new(this.branchInput).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(div().px(8).pb(2).flex_none().text_size(10.5).text_color(t.dim).child(`${list.length} branches`))
      .child(item("gg-ball", h_flex().gap(8).child(div().w(12).text_color(C.green).child(this.filterBranch ? "" : "✓")).child("Show All"), pick(null)))
      .child(v_flex().id("gg-blist").flex_1().min_h(0).overflow_y_scrollbar().children(list.map((b, i) => item(`gg-b-${i}`,
        h_flex().gap(8).items_center().min_w(0).flex_1()
          .child(div().w(12).flex_none().text_color(C.green).child(this.filterBranch === b.name ? "✓" : ""))
          .child(div().flex_1().min_w(0).truncate().text_color(b.head ? C.green : b.remote ? "#b9a3ff" : "#ffffff").child(b.name))
          .when(b.head, (el) => el.child(div().flex_none().text_size(10).text_color(C.green).child("HEAD")))
          .when(Boolean(b.track), (el) => el.child(div().flex_none().text_size(10.5).text_color(C.yellow).child(b.track))),
        pick(b.name)))));
  }
}

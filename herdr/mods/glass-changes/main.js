import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, checking, openOverlay, nextCommand } from "herdr";
import { READ, discoverRepositories, readRepositories, repoName } from "./repositories.js";

const MOD = "glass-changes";
const icon = (name) => `mods/${MOD}/${name}.svg`;
const MAX_WATCHES = 6;
const REPO_ROW = 32, ROW = 26;
const WRITE_TIMEOUT = 120000; // commit hooks can be slow

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const total = (files, field) => files.reduce((n, f) => n + f[field], 0);
const inside = (path, dir) => path === dir || path.startsWith(dir.replace(/\/$/, "") + "/");
const chunks = (list, size = 200) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// Source Control in the style of VS Code: every checkout of the repo (linked worktrees too)
// is a group with "Staged Changes" and "Changes"; Commit takes only what is staged.
export default class Changes extends View {
  init(_props, cx) {
    this.repos = []; this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.selectedRoot = null; this.previewRevision = 0; this.collapsed = {}; this.watchers = new Map();
    this.hover = null; this.pendingDiscard = null; this.busyLabel = null;
    try {
      const saved = JSON.parse(localStorage.getItem("collapsed-repositories") || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) this.collapsed = saved;
    } catch {}
    this.input = InputState.new({ placeholder: "Commit message (Enter to commit staged)" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // The discard confirmation dialog answers with `glass-changes.discard`.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "discard") this.discardConfirmed(cx);
        cx.notify();
      }
    });
  }

  // Watches the folder the panel is about, plus every worktree that lives outside it.
  syncWatches(roots, cx) {
    if (this.on) { this.stopWatch(); return; }
    const wanted = new Set(roots.slice(0, MAX_WATCHES));
    for (const [root, watcher] of this.watchers) {
      if (!wanted.has(root)) { this.watchers.delete(root); watcher.pending?.cancel(); }
    }
    for (const root of wanted) {
      if (this.watchers.has(root)) continue;
      const watcher = { pending: null };
      this.watchers.set(root, watcher);
      cx.spawn(async (cx) => {
        try {
          while (this.watchers.get(root) === watcher) {
            watcher.pending = watchFolder(root);
            await watcher.pending;
            if (this.watchers.get(root) === watcher) this.refresh(cx);
          }
        } catch { if (this.watchers.get(root) === watcher) this.watchers.delete(root); }
      });
    }
  }

  stopWatch() {
    for (const watcher of this.watchers.values()) watcher.pending?.cancel();
    this.watchers.clear();
  }

  close() { this.stopWatch(); }

  repoKey(root) { return JSON.stringify([this.on ?? null, root]); }
  sectionKey(root, section) { return `${this.repoKey(root)}#${section}`; }
  isCollapsed(root) { return Boolean(this.collapsed[this.repoKey(root)]); }
  saveCollapsed() { localStorage.setItem("collapsed-repositories", JSON.stringify(this.collapsed)); }

  selectRepo(root) {
    if (this.selectedRoot === root) return;
    this.selectedRoot = root; this.message = ""; this.input.set_value(""); this.note = null;
    this.open = null; this.previewRevision++; this.setLines([]);
  }

  // The checkout the terminal is in when it has changes, else the first checkout that has some.
  defaultRoot() {
    if (this.workspace) return null;
    const current = this.repos.find((r) => r.current) ?? this.repos[0];
    if (current?.totalFiles) return current.root;
    return (this.repos.find((r) => r.totalFiles > 0) ?? current)?.root ?? null;
  }

  toggleRepo(root, cx) {
    if (this.busy || this.context !== key()) return;
    this.selectRepo(root);
    this.collapsed[this.repoKey(root)] = !this.isCollapsed(root);
    this.saveCollapsed(); cx.notify();
  }

  toggleSection(root, section, cx) {
    const k = this.sectionKey(root, section);
    this.collapsed[k] = !this.collapsed[k];
    this.saveCollapsed(); cx.notify();
  }

  foldAll(collapse, cx) {
    for (const repo of this.repos) this.collapsed[this.repoKey(repo.root)] = collapse;
    this.saveCollapsed(); cx.notify();
  }

  setHover(id, hovered, cx) {
    const next = hovered ? id : this.hover === id ? null : this.hover;
    if (next !== this.hover) { this.hover = next; cx.notify(); }
  }

  refresh(cx) {
    if (checking()) return;
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.stopWatch(); this.previewRevision++;
      this.context = context; this.repos = []; this.files = []; this.open = null; this.selectedRoot = null; this.pendingDiscard = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.closed = false;
    }
    if (!cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const discovery = await discoverRepositories(exec, cwd, on);
        if (key() !== context) return;
        const repos = await readRepositories(exec, discovery.repos, on);
        if (key() !== context) return;
        this.repos = repos; this.on = on; this.workspace = discovery.workspace;
        this.files = repos.flatMap((r) => r.files); this.error = null;
        if (!repos.some((r) => r.root === this.selectedRoot)) this.selectRepo(this.defaultRoot());
        const base = discovery.workspace ? cwd : (repos.find((r) => r.current) ?? repos[0])?.root ?? cwd;
        this.syncWatches([base, ...repos.map((r) => r.root).filter((root) => !inside(root, base))], cx);
        if (this.open && !this.files.some((f) => f.id === this.open)) {
          // A file that was staged or unstaged keeps its preview, now from the other list.
          const [root, , path] = JSON.parse(this.open);
          this.open = this.files.find((f) => f.root === root && f.path === path)?.id ?? null;
          this.previewRevision++; this.setLines([]);
        }
        // A parent folder starts with the overview. Inside a repo keep the familiar first diff.
        if (!this.workspace && !this.open && !this.closed && this.files.length) {
          const selected = repos.find((r) => r.root === this.selectedRoot);
          this.open = (selected?.files[0] ?? this.files[0]).id;
        }
        if (this.open) {
          const id = this.open;
          try { await this.load(id, context); }
          catch { if (key() === context && this.open === id) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again || key() !== this.context) this.refresh(cx);
      }
    });
  }

  async load(id, context) {
    const file = this.files.find((f) => f.id === id), on = this.on;
    if (!file) return;
    const { root, path, section } = file, revision = ++this.previewRevision;
    let lines;
    if (file.fresh) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      // Staged: index against HEAD. Unstaged: working tree against the index.
      const which = section === "staged" ? ["--cached"] : [];
      const r = await exec("git", [...READ, "diff", ...which, "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === id && this.previewRevision === revision) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(id, cx) {
    if (this.busy || this.context !== key()) return;
    const file = this.files.find((f) => f.id === id);
    if (!file) return;
    this.selectRepo(file.root); this.previewRevision++;
    this.open = this.open === id ? null : id; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(id, context); }
      catch (e) { if (key() === context && this.open === id) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // Runs git write commands one after another in `repo`, then reloads.
  // Paths are literal: a file named `*.js` never matches other files.
  git(repo, steps, cx, { label, failure, done } = {}) {
    if (!repo || !steps.length || this.busy || this.context !== key()) return;
    const root = repo.root, on = this.on, context = this.context;
    this.selectRepo(root);
    this.busy = true; this.busyLabel = label ?? null; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await exec("git", ["--literal-pathspecs", ...args], { cwd: root, on, timeout: WRITE_TIMEOUT });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} exited with ${r.code}`);
        }
        if (key() === context) done?.();
      } catch (e) { if (key() === context) this.note = `${failure ?? "Git failed"}: ${e?.message ?? e}`; }
      finally { this.busy = false; this.busyLabel = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  stage(repo, files, cx) {
    const paths = files.map((f) => f.path);
    this.git(repo, chunks(paths).map((p) => ["add", "-A", "--", ...p]), cx, { failure: "Stage failed" });
  }

  stageAll(repo, cx) { this.git(repo, [["add", "-A"]], cx, { failure: "Stage failed" }); }

  unstage(repo, files, cx) {
    const paths = files.map((f) => f.path);
    const steps = repo.hasHead
      ? chunks(paths).map((p) => ["reset", "-q", "--", ...p])
      : chunks(paths).map((p) => ["rm", "--cached", "-q", "--", ...p]);
    this.git(repo, steps, cx, { failure: "Unstage failed" });
  }

  unstageAll(repo, cx) {
    this.git(repo, [repo.hasHead ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "--", "."]], cx, { failure: "Unstage failed" });
  }

  // Discarding loses work, so it always asks first (the shipped confirm dialog).
  askDiscard(repo, files) {
    if (this.busy || this.context !== key()) return;
    files = files.filter((f) => f.section === "unstaged" && !f.conflict);
    if (!files.length) return;
    this.pendingDiscard = { context: this.context, root: repo.root, files: files.map(({ path, fresh }) => ({ path, fresh })) };
    const fresh = files.filter((f) => f.fresh).length, one = files.length === 1;
    const title = one ? `Discard changes in ${files[0].path.split("/").pop()}?` : `Discard ${files.length} changes in ${repo.name}?`;
    const detail = fresh === files.length
      ? `${one ? "This untracked file" : `These ${fresh} untracked files`} will be deleted. This can't be undone.`
      : `Unstaged changes will be lost${fresh ? ` and ${plural(fresh, "untracked file")} deleted` : ""}. Staged changes are kept. This can't be undone.`;
    openOverlay({ mod: "confirm", kind: "dialog", width: 460, height: 190, props: { title, detail, command: { name: `${MOD}.discard` } } });
  }

  discardConfirmed(cx) {
    const pending = this.pendingDiscard;
    this.pendingDiscard = null;
    if (!pending || pending.context !== this.context || pending.context !== key()) return;
    const repo = this.repos.find((r) => r.root === pending.root);
    if (!repo) return;
    const tracked = pending.files.filter((f) => !f.fresh).map((f) => f.path);
    const untracked = pending.files.filter((f) => f.fresh).map((f) => f.path);
    this.git(repo, [
      // checkout restores the working tree from the index: staged work stays.
      ...chunks(tracked).map((p) => ["checkout", "-q", "--", ...p]),
      ...chunks(untracked).map((p) => ["clean", "-f", "-q", "--", ...p]),
    ], cx, { failure: "Discard failed" });
  }

  // Commits the index only: nothing is added for you.
  commit(cx) {
    const repo = this.repos.find((r) => r.root === this.selectedRoot);
    if (!this.message.trim() || !repo?.staged.length || repo.error || this.busy || this.context !== key()) return;
    const message = this.message.trim();
    this.git(repo, [["commit", "-q", "-m", message]], cx, {
      label: "Committing…", failure: "Commit failed",
      done: () => { this.message = ""; this.input.set_value(""); },
    });
  }

  iconButton(id, name, tip, onPress, t) {
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onPress(cx); })
      .child(svg(icon(name)).size(13));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  statusColor(status, t) {
    if (status === "A" || status === "U") return t.ansi2;
    if (status === "D" || status === "!") return t.ansi1;
    if (status === "R" || status === "C") return t.accent;
    return t.blocked;
  }

  fileRow(f, repo, t) {
    const parts = f.path.split("/"), name = parts.pop(), showActions = this.hover === f.id || this.open === f.id;
    const actions = f.section === "staged"
      ? [this.iconButton(`unstage-${f.id}`, "minus", "Unstage changes", (cx) => this.unstage(repo, [f], cx), t)]
      : [
        ...(f.conflict ? [] : [this.iconButton(`discard-${f.id}`, "discard", f.fresh ? "Delete untracked file" : "Discard changes", () => this.askDiscard(repo, [f]), t)]),
        this.iconButton(`stage-${f.id}`, "plus", f.conflict ? "Mark as resolved (stage)" : "Stage changes", (cx) => this.stage(repo, [f], cx), t),
      ];
    return h_flex().id(`change-${f.id}`).h(ROW).flex_none().pl(34).pr(6).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.id, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((hovered, cx) => this.setHover(f.id, hovered, cx))
      .on_click((_e, cx) => this.pick(f.id, cx))
      .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(this.statusColor(f.status, t)).child(f.status))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().max_w(260).min_w(0).truncate().when(f.status === "D", (e) => e.line_through().text_color(t.muted)).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
      .when(showActions, (e) => e.child(h_flex().flex_none().gap(2).children(actions)))
      .when(!showActions && f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(!showActions && f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  sectionRow(repo, section, files, t) {
    const staged = section === "staged", folded = Boolean(this.collapsed[this.sectionKey(repo.root, section)]);
    const id = this.sectionKey(repo.root, section);
    const actions = staged
      ? [this.iconButton(`unstage-all-${id}`, "minus", "Unstage all changes", (cx) => this.unstageAll(repo, cx), t)]
      : [
        this.iconButton(`discard-all-${id}`, "discard", "Discard all changes", () => this.askDiscard(repo, files), t),
        this.iconButton(`stage-all-${id}`, "plus", "Stage all changes", (cx) => this.stageAll(repo, cx), t),
      ];
    return h_flex().id(`section-${id}`).h(ROW).flex_none().pl(20).pr(6).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleSection(repo.root, section, cx))
      .child(div().w(10).text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(staged ? t.foreground : t.muted)
        .child(staged ? "Staged Changes" : "Changes"))
      .child(h_flex().flex_none().gap(2).children(actions))
      .child(div().min_w(20).h(16).px(5).flex().items_center().justify_center().rounded(8).bg(staged ? t.accent : t.raised)
        .text_size(10).text_color(staged ? t.accent_foreground : t.muted).child(String(files.length)));
  }

  // Each row with its height, so the list takes exactly the room it needs.
  repoRows(repo, t) {
    const collapsed = this.isCollapsed(repo.root);
    const add = total(repo.files, "add"), del = total(repo.files, "del");
    const showBranch = Boolean(repo.branch) && repo.branch !== repo.name;
    const rows = [{ h: REPO_ROW, el: h_flex().id(`repo-${repo.root}`).h(REPO_ROW).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.selectedRoot === repo.root, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip(repo.root)
      .on_click((_e, cx) => this.toggleRepo(repo.root, cx))
      .child(div().w(10).text_color(t.dim).child(collapsed ? "▸" : "▾"))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().min_w(0).truncate().font_semibold().child(repo.name))
        .when(repo.linked, (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.accent + "2e").text_size(10).text_color(t.accent).child("worktree")))
        .when(showBranch, (e) => e.child(h_flex().min_w(0).gap(3).items_center().text_size(11).text_color(t.dim)
          .child(svg(icon("branch")).size(11).flex_none()).child(div().min_w(0).truncate().child(repo.branch)))))
      .child(div().text_size(10).text_color(repo.error ? t.ansi1 : t.muted).child(repo.error ? "Error" : String(repo.totalFiles)))
      .when(add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))) }];
    if (collapsed) return rows;
    if (repo.error || !repo.files.length) {
      rows.push({ h: ROW, el: div().h(ROW).flex_none().flex().items_center().pl(26).pr(8).text_size(11).text_color(repo.error ? t.ansi1 : t.dim).truncate().child(repo.error || "No uncommitted changes") });
      return rows;
    }
    for (const [section, files] of [["staged", repo.staged], ["unstaged", repo.unstaged]]) {
      if (!files.length) continue;
      rows.push({ h: ROW, el: this.sectionRow(repo, section, files, t) });
      if (!this.collapsed[this.sectionKey(repo.root, section)]) rows.push(...files.map((f) => ({ h: ROW, el: this.fileRow(f, repo, t) })));
    }
    if (repo.limited) rows.push({ h: ROW, el: div().h(ROW).flex_none().flex().items_center().pl(26).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files") });
    return rows;
  }

  commitHint(selected) {
    if (!selected) return "Select a repository to commit";
    const where = `${selected.branch ? `${selected.branch} · ` : ""}${selected.name}${selected.linked ? " (worktree)" : ""}`;
    if (selected.staged.length) return `Commit ${plural(selected.staged.length, "staged file")} to ${where}`;
    if (selected.unstaged.length) return `Nothing staged in ${where} · press + to stage`;
    return `Nothing to commit in ${where}`;
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = total(this.files, "add"), del = total(this.files, "del");
    const selected = this.repos.find((r) => r.root === this.selectedRoot), openFile = this.files.find((f) => f.id === this.open);
    const enabled = Boolean(this.message.trim() && selected?.staged.length && !selected.error && !this.busy && this.context === key());
    const rows = this.repos.flatMap((repo) => this.repoRows(repo, t)), list = rows.map((r) => r.el);
    const listHeight = rows.reduce((n, r) => n + r.h, 0) + 12;
    const allFolded = this.repos.length > 0 && this.repos.every((r) => this.isCollapsed(r.root));
    const totalFiles = this.repos.reduce((n, r) => n + r.totalFiles, 0);
    const worktrees = this.repos.filter((r) => r.linked).length;
    const summary = `${plural(this.repos.length - worktrees, "repository", "repositories")}${worktrees ? ` · ${plural(worktrees, "worktree")}` : ""}${this.loading ? " · Updating…" : ""}`;
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg("#14161ba6").border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${totalFiles} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .when(this.repos.length > 0, (e) => e.child(h_flex().h(28).flex_none().px(14).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(summary))
        .child(div().id("fold-repositories").px(5).py(2).rounded(4).text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.foldAll(!allFolded, cx)).child(allFolded ? "Expand all" : "Collapse all"))))
      .when(Boolean(this.error), (e) => e.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.error)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(Math.max(44, listHeight)).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(list)
          .when(!list.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.loading ? "Loading repositories…" : location().cwd ? "No Git repositories in this folder or its immediate subfolders" : "No folder"))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(Boolean(openFile), (e) => e.child(h_flex().h(28).flex_none().px(12).gap(6).items_center().text_size(11).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(openFile ? `${repoName(openFile.root)} · ${openFile.path}` : ""))
        .child(div().flex_none().px(5).rounded(4).bg(openFile?.section === "staged" ? t.accent + "2e" : t.raised).text_size(10)
          .text_color(openFile?.section === "staged" ? t.accent : t.dim).child(openFile?.section === "staged" ? "Staged" : "Working tree"))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(div().px(12).py(6).text_size(11).text_color(selected?.staged.length ? t.muted : t.dim).truncate().child(this.commitHint(selected)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12)
          .tooltip(selected?.staged.length ? "Commit staged changes" : "Stage changes first").when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx))
          .child(this.busyLabel ?? (this.busy ? "Working…" : "Commit"))));
  }
}

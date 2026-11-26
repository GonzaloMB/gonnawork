// Shared by the native panel and the integration tests. All reads avoid index writes.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const fileId = (root, section, path) => JSON.stringify([root, section, path]);
export const repoName = (root) => root.replace(/\/$/, "").split("/").pop() || root;

// Porcelain XY pairs that mean "unmerged".
const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const firstLine = (text) => text.replace(/\r?\n$/, "");

async function mapLimit(items, fn, limit = 4) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      output[i] = await fn(items[i]);
    }
  }));
  return output;
}

const byName = (a, b) => repoName(a).localeCompare(repoName(b));

// The repositories in the direct children of `dir`, each by its top level.
async function scanChildren(exec, dir, on) {
  // Direct children only: no dependency-tree crawl. .git may be a worktree file.
  // Paths are positional arguments and NUL-delimited, including spaces/newlines.
  const scan = await exec("sh", ["-c", `
    for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do
      [ -d "$child" ] || continue
      if [ -d "$child/.git" ] || [ -f "$child/.git" ]; then
        printf '%s\\0' "$child"
      fi
    done
  `, "changes-repositories", dir], { cwd: dir, on });
  if (scan.code !== 0) throw new Error(scan.stderr || "Cannot list project folders");
  const candidates = scan.stdout.split("\0").filter(Boolean);
  const resolved = await mapLimit(candidates, async (root) => {
    const r = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd: root, on });
    // Keep unreadable repositories so their error can be shown in their own group.
    return r.code === 0 ? firstLine(r.stdout) : root;
  });
  return [...new Set(resolved)].sort(byName);
}

// Every checkout of the repository at `root`: the main one first, then linked worktrees.
// Bare and prunable (folder gone) entries are left out.
async function listWorktrees(exec, root, on) {
  const r = await exec("git", [...READ, "worktree", "list", "--porcelain"], { cwd: root, on }).catch(() => null);
  if (!r || r.code !== 0) return [];
  const entries = [];
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const w = {};
    for (const line of block.split(/\r?\n/)) {
      const space = line.indexOf(" ");
      const field = space < 0 ? line : line.slice(0, space), value = space < 0 ? "" : line.slice(space + 1);
      if (field === "worktree") w.path = value;
      else if (field === "branch") w.branch = value.replace(/^refs\/heads\//, "");
      else if (field === "HEAD") w.head = value.slice(0, 7);
      else if (field === "detached") w.detached = true;
      else if (field === "bare") w.bare = true;
      else if (field === "prunable") w.prunable = true;
    }
    if (w.path) entries.push(w);
  }
  return entries
    .map((w, i) => ({ ...w, main: i === 0, branch: w.branch ?? (w.detached && w.head ? `detached at ${w.head}` : null) }))
    .filter((w) => !w.bare && !w.prunable);
}

// The repositories to show for `cwd`, each checkout of each one as its own group:
// [{ root, linked, branch, current }]. `current` is the checkout the folder is in.
// Inside a repository: that one first, then the repositories cloned in its direct
// children (gitignored checkouts, submodules), each followed by its worktrees.
export async function discoverRepositories(exec, cwd, on) {
  const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on });
  const workspace = top.code !== 0;
  const current = workspace ? null : firstLine(top.stdout);
  let roots, families;
  if (workspace) {
    roots = await scanChildren(exec, cwd, on);
    families = await mapLimit(roots, (root) => listWorktrees(exec, root, on));
  } else {
    const family = await listWorktrees(exec, current, on);
    // A linked worktree has none of the main checkout's gitignored clones: look in both.
    const main = family.find((w) => w.main)?.path;
    const own = new Set([current, ...family.map((w) => w.path)]);
    const dirs = [...new Set([current, main].filter(Boolean))];
    // The repository itself still shows if its children can't be listed.
    const scans = await mapLimit(dirs, (dir) => scanChildren(exec, dir, on).catch(() => []));
    const nested = [...new Set(scans.flat())].filter((root) => !own.has(root)).sort(byName);
    roots = [current, ...nested];
    families = [family, ...await mapLimit(nested, (root) => listWorktrees(exec, root, on))];
  }
  const repos = [], seen = new Set();
  const add = (repo) => { if (!seen.has(repo.root)) { seen.add(repo.root); repos.push(repo); } };
  roots.forEach((root, i) => {
    const family = families[i];
    if (!family.some((w) => w.path === root)) add({ root, linked: false, branch: null, current: root === current });
    for (const w of family) add({ root: w.path, linked: !w.main, branch: w.branch, current: w.path === current });
  });
  return { workspace, repos };
}

async function numstat(git, args) {
  const r = await git(["diff", ...args, "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  const stats = {};
  for (const entry of r.stdout.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  return stats;
}

// Splits `git status` into the index (staged) and the working tree (unstaged), as
// VS Code's Source Control does. A file changed in both shows in both lists.
export async function readRepository(exec, info, on) {
  const { root } = info;
  const repo = { ...info, name: repoName(root), staged: [], unstaged: [], files: [], hasHead: false, totalFiles: 0, limited: false, error: null };
  const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  try {
    const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr || status.stdout);
    const [head, stagedStats, unstagedStats] = await Promise.all([
      git(["rev-parse", "--verify", "-q", "HEAD"]), numstat(git, ["--cached"]), numstat(git, []),
    ]);
    repo.hasHead = head.code === 0;
    const entries = status.stdout.split("\0").filter(Boolean);
    repo.totalFiles = entries.length;
    repo.limited = entries.length > 1000;
    for (const entry of entries.slice(0, 1000)) {
      const x = entry[0], y = entry[1], path = entry.slice(3);
      const file = (section, status, extra = {}) => ({
        id: fileId(root, section, path), root, path, section, status, fresh: false, conflict: false,
        ...((section === "staged" ? stagedStats : unstagedStats)[path] ?? { add: 0, del: 0, binary: false }), ...extra,
      });
      if (CONFLICTS.has(x + y)) repo.unstaged.push(file("unstaged", "!", { conflict: true }));
      else if (x === "?") repo.unstaged.push(file("unstaged", "U", { fresh: true }));
      else if (x !== "!") {
        if (x !== " ") repo.staged.push(file("staged", x === "T" ? "M" : x));
        if (y !== " ") repo.unstaged.push(file("unstaged", y === "T" ? "M" : y));
      }
    }
    repo.files = [...repo.staged, ...repo.unstaged];
  } catch (e) { repo.error = String(e?.message || e).trim(); }
  return repo;
}

export const readRepositories = (exec, repos, on) => mapLimit(repos, (repo) => readRepository(exec, repo, on));

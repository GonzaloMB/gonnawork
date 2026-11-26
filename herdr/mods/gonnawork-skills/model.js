// What the Skills panel knows, apart from drawing it: the skills on disk, what Claude Code really
// loads (its own /context, run locally: no model call, hooks off), skillOverrides resolved the
// way Claude Code resolves them, and writing them the way its /skills screen does.
//
// skillOverrides: { "<name>": "on" | "name-only" | "user-invocable-only" | "off" }, absent = on.
// Claude Code merges settings per key (this project's .claude/settings.local.json over the
// repo's .claude/settings.json over ~/.claude/settings.json) and tries the skill's full name
// first, then its short one ("anthropic-skills:docx", then "docx"). Plugin skills ignore it:
// they go on and off with their plugin. permissions.deny Skill(x) only blocks the tool call:
// the skill stays listed and keeps costing context, so the panel replaces those rules.

import { exec, readTextFile, writeTextFile, home } from "herdr";

export const STATES = ["on", "name-only", "user-invocable-only", "off"];
export const STATE = {
  on: { label: "On", hint: "Claude sees its name and description and uses it when it fits" },
  "name-only": { label: "Name only", hint: "Claude sees only the name: it uses it when you mention it" },
  "user-invocable-only": { label: "Only /command", hint: "Hidden from Claude; you can still run it with /name" },
  off: { label: "Off", hint: "Hidden from Claude and from your / menu" },
};
export const SYNCED = "anthropic-skills";

export const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
export const basename = (p) => p.replace(/\/+$/, "").split("/").pop();
export function tilde(p) {
  const h = home();
  return p === h ? "~" : p?.startsWith(h + "/") ? "~" + p.slice(h.length) : p ?? "";
}
export const userSettings = () => home() + "/.claude/settings.json";
export const localSettings = (root) => root + "/.claude/settings.local.json";
export const sharedSettings = (root) => root + "/.claude/settings.json";

// ---- On disk ----

// kind\0path\0bytes\0frontmatter\0extra\0 for every skill, instruction file and archived skill.
const SCRIPT = String.raw`emit() { printf '%s\0%s\0%s\0' "$1" "$2" "$(wc -c < "$2" | tr -d ' ')"; sed -n '1,60p' "$2" | awk 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} NR>1{print}'; printf '\0%s\0' "$3"; }
scan() { [ -d "$2" ] || return 0; find -L "$2" -maxdepth "$3" -name SKILL.md -not -path '*/node_modules/*' -not -path '*/marketplaces/*' 2>/dev/null | sort | while IFS= read -r f; do emit "$1" "$f" ""; done; }
cwd=$1; top=$2; d=$cwd
while [ "$d" != "$HOME" ]; do
  scan project "$d/.claude/skills" 3
  for s in .agents/skills .codex/skills .opencode/skills .opencode/skill .cursor/skills; do scan other "$d/$s" 3; done
  for m in CLAUDE.md CLAUDE.local.md .claude/CLAUDE.md AGENTS.md GEMINI.md; do [ -f "$d/$m" ] && emit instr "$d/$m" ""; done
  if [ "$d" = "$top" ] || [ "$d" = / ]; then break; fi
  d=$(dirname "$d")
done
scan user "$HOME/.claude/skills" 2
scan synced "$HOME/.claude/skills/synced" 3
for s in "$HOME/.agents/skills" "$HOME/.codex/skills" "$HOME/.config/opencode/skills" "$HOME/.cursor/skills"; do scan other "$s" 4; done
[ -f "$HOME/.claude/CLAUDE.md" ] && emit instr "$HOME/.claude/CLAUDE.md" ""
[ -f "$HOME/.codex/AGENTS.md" ] && emit instr "$HOME/.codex/AGENTS.md" ""
scan plugin "$HOME/.claude/plugins" 9
for f in "$HOME"/.claude/skills-archived/*/SKILL.md; do [ -f "$f" ] && emit archived "$f" "$(cat "$(dirname "$f")/.archived-from" 2>/dev/null)"; done
true`;

// key: value, with | and > blocks, quotes removed.
function frontmatter(text) {
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

// Which agent reads a skill folder or instruction file that isn't Claude Code's.
function agentOf(path) {
  if (/\/\.cursor\//.test(path)) return "Cursor";
  if (/opencode\//.test(path)) return "OpenCode";
  if (/GEMINI\.md$/.test(path)) return "Gemini";
  if (/\/\.codex\/|\/\.agents\/|AGENTS\.md$/.test(path)) return "Codex";
  return null;
}

function makeItem(kind, path, bytes, fm, extra) {
  const meta = frontmatter(fm);
  const parts = path.split("/");
  const file = parts.at(-1);
  if (kind === "instr") {
    const claude = /CLAUDE(\.local)?\.md$/.test(file);
    return { kind, path, dir: path, name: parts.at(-2) === ".claude" ? ".claude/" + file : file, desc: "", bytes: Number(bytes) || 0,
      agent: claude ? null : agentOf(path), user: path.startsWith(home() + "/.claude/") || path.startsWith(home() + "/.codex/") };
  }
  const name = meta.name || parts.at(-2);
  let plugin = null;
  if (kind === "plugin") {
    let j = parts.lastIndexOf("skills") - 1;
    if (j > 0 && /^v?\d+(\.\d+)*$/.test(parts[j])) j--;
    plugin = j >= 0 ? parts[j] : null;
  }
  const keys = kind === "synced" ? [`${SYNCED}:${name}`, name] : kind === "plugin" && plugin ? [`${plugin}:${name}`] : [name];
  return { kind, path, dir: dirname(path), name, plugin, desc: meta.description || "", bytes: Number(bytes) || 0,
    agent: kind === "other" ? agentOf(path) : null, keys, origin: kind === "archived" ? extra || null : null };
}

export async function scanDisk(cwd, top, on) {
  const r = await exec("sh", ["-c", SCRIPT, "skills", cwd, top], { on, timeout: 20000 });
  const f = r.stdout.split("\0");
  const items = [], seen = new Set(), synced = new Set();
  for (let i = 0; i + 4 < f.length; i += 5) {
    const kind = f[i].replace(/^\n+/, ""), path = f[i + 1];
    if (!kind || !path || seen.has(path)) continue;
    seen.add(path);
    const item = makeItem(kind, path, f[i + 2], f[i + 3], f[i + 4]);
    // Every Claude account signed in here syncs its own copy: list each skill once.
    if (kind === "synced") { if (synced.has(item.name)) continue; synced.add(item.name); }
    items.push(item);
  }
  return items;
}

// ---- What Claude Code loads ----

function num(s) {
  const m = /([\d.]+)\s*([kKM]?)/.exec(s ?? "");
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] ? 1e3 : 1);
  return /^\s*</.test(s) ? Math.min(n, 10) : n;
}

// Claude Code's /context, in markdown: totals, each loaded skill with its source, memory files.
export function parseContext(text) {
  const out = { model: null, total: null, window: null, skillsTotal: null, memoryTotal: null, skills: [], memory: [] };
  let section = null;
  for (const line of text.split("\n")) {
    const h = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (h) { section = h[1]; continue; }
    const model = /^\*\*Model:\*\*\s*(\S+)/.exec(line);
    if (model) { out.model = model[1]; continue; }
    const tok = /^\*\*Tokens:\*\*\s*([\d.]+[kKM]?)\s*\/\s*([\d.]+[kKM]?)/.exec(line);
    if (tok) { out.total = num(tok[1]); out.window = num(tok[2]); continue; }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((s) => s.trim());
    if (cells.length < 2 || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (/usage by category/i.test(section ?? "")) {
      if (cells[0] === "Skills") out.skillsTotal = num(cells[1]);
      if (cells[0] === "Memory files") out.memoryTotal = num(cells[1]);
    } else if (section === "Skills" && cells.length >= 3 && cells[0] !== "Skill") {
      out.skills.push({ name: cells[0], source: cells[1], tokens: num(cells[2]) });
    } else if (/^Memory Files$/i.test(section ?? "") && cells.length >= 3 && num(cells[2]) !== null && cells[1].includes("/")) {
      out.memory.push({ type: cells[0], path: cells[1], tokens: num(cells[2]) });
    }
  }
  return out;
}

// Runs here only. disableAllHooks keeps it from starting session hooks (claude-multi's).
export async function claudeContext(cwd) {
  const r = await exec("sh", ["-c", 'CC_MULTI_RENEWING=1 exec claude -p /context --no-session-persistence --settings \'{"disableAllHooks":true}\'', "ctx"], { cwd, timeout: 45000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `claude exited ${r.code}`);
  const c = parseContext(r.stdout);
  if (c.window === null && !c.skills.length) throw new Error("Couldn't read Claude Code's /context");
  return c;
}

// ---- Overrides ----

export async function readJson(path, on) {
  const text = await readTextFile(path, on ? { on } : undefined).catch(() => null);
  if (text === null || !text.trim()) return { text, obj: {} };
  try {
    const obj = JSON.parse(text);
    return { text, obj: obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {}, bad: !obj || typeof obj !== "object" || Array.isArray(obj) };
  } catch {
    return { text, obj: {}, bad: true };
  }
}

const overridesIn = (obj) => (obj?.skillOverrides && typeof obj.skillOverrides === "object" && !Array.isArray(obj.skillOverrides) ? obj.skillOverrides : {});
const denyIn = (obj) => (Array.isArray(obj?.permissions?.deny) ? obj.permissions.deny : []).map((r) => /^Skill\((.+)\)$/.exec(r)?.[1]).filter(Boolean);

// The three settings files' overrides and old-style deny rules.
export async function readSettings(root, on) {
  const user = await readJson(userSettings(), on);
  const shared = root ? await readJson(sharedSettings(root), on) : { obj: {} };
  const local = root ? await readJson(localSettings(root), on) : { obj: {} };
  const first = (k) => [local.obj[k], shared.obj[k], user.obj[k]].find((v) => v !== undefined);
  return {
    user: overridesIn(user.obj), shared: overridesIn(shared.obj), local: overridesIn(local.obj),
    deny: { user: denyIn(user.obj), local: denyIn(local.obj) },
    // false: claude.ai skills aren't synced into sessions here. true: no built-in skills.
    sync: first("syncClaudeAiSkills"), noBundled: first("disableBundledSkills"),
    bad: [user.bad && userSettings(), local.bad && root && localSettings(root)].filter(Boolean),
  };
}

// The state Claude Code gives a skill and the file that decides it.
export function resolve(item, s) {
  const files = [["local", s.local], ["shared", s.shared], ["user", s.user]];
  for (const key of item.keys ?? []) {
    for (const [scope, ov] of files) {
      const v = ov[key];
      if (STATES.includes(v)) return { value: v, scope, key };
    }
  }
  return { value: "on", scope: null, key: null };
}

// Its state without this project's own override: what "This project" compares against.
export function baseState(item, s) {
  return resolve(item, { local: {}, shared: s.shared, user: s.user }).value;
}

export function denied(item, s) {
  return (item.keys ?? []).some((k) => s.deny.user.includes(k) || s.deny.local.includes(k));
}

// Changes one settings file through `change(obj)`; leaves a file that isn't a JSON object alone.
async function editJson(path, change) {
  const { text, obj, bad } = await readJson(path);
  if (bad) throw new Error(`${tilde(path)} isn't valid JSON; left it alone`);
  change(obj);
  await exec("mkdir", ["-p", dirname(path)]);
  await writeTextFile(path, JSON.stringify(obj, null, 2) + "\n", text);
}

function setKeys(obj, keys, value) {
  const ov = { ...overridesIn(obj) };
  for (const k of keys) delete ov[k];
  if (value) ov[keys[0]] = value;
  if (Object.keys(ov).length) obj.skillOverrides = ov;
  else delete obj.skillOverrides;
  // The deny rule was the old way to turn it off: the override replaces it.
  if (Array.isArray(obj.permissions?.deny)) obj.permissions.deny = obj.permissions.deny.filter((r) => !keys.some((k) => r === `Skill(${k})`));
}

// scope "user": everywhere (~/.claude/settings.json); "project": this project only, in
// .claude/settings.local.json, which stays out of git. "on" there is written only when it
// has to beat a value from elsewhere.
export async function applyState(item, scope, value, root, s) {
  if (scope === "project") return editJson(localSettings(root), (o) => setKeys(o, item.keys, value === baseState(item, s) ? null : value));
  return editJson(userSettings(), (o) => setKeys(o, item.keys, value === "on" ? null : value));
}

// Every Skill(x) deny rule becomes skillOverrides off, under the name Claude Code lists it by.
export async function migrateDeny(root, items) {
  const keyFor = (name) => items.find((i) => i.keys?.includes(name))?.keys[0] ?? name;
  const move = (o) => {
    const deny = Array.isArray(o.permissions?.deny) ? o.permissions.deny : [];
    const ov = { ...overridesIn(o) };
    for (const r of deny) {
      const name = /^Skill\((.+)\)$/.exec(r)?.[1];
      if (!name) continue;
      const key = keyFor(name);
      if (!STATES.includes(ov[key]) && !STATES.includes(ov[name])) ov[key] = "off";
    }
    o.skillOverrides = ov;
    o.permissions.deny = deny.filter((r) => !/^Skill\(.+\)$/.test(r));
  };
  const s = await readSettings(root, null);
  if (s.deny.user.length) await editJson(userSettings(), move);
  if (root && s.deny.local.length) await editJson(localSettings(root), move);
}

// ---- Archive ----

export async function archive(item) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const dest = `${home()}/.claude/skills-archived/${item.name.replace(/[/:]/g, "_")}-${stamp}`;
  const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && mv "$1" "$2" && printf %s "$1" > "$2/.archived-from"', "sh", item.dir, dest]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  return dest;
}

export async function restore(item) {
  if (!item.origin) throw new Error("It doesn't say where it came from: move it back by hand");
  const r = await exec("sh", ["-c", 'if [ -e "$2" ]; then echo "$2 already exists" >&2; exit 3; fi; mkdir -p "$(dirname "$2")" && mv "$1" "$2" && rm -f "$2/.archived-from"', "sh", item.dir, item.origin]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  return item.origin;
}


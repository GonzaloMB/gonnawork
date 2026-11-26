// File and folder icons as VS Code draws them: Seti for files, Material for folders,
// in the theme's Apple system colors. Each icon is a full-color SVG in ./icons
// (`<glyph>--<color>.svg`), cut from the Nerd Font glyph of that name and filled
// with a light-to-color gradient, so it reads as glass on the panel.

const BLUE = "#409cff", CYAN = "#64d2ff", TEAL = "#40c8e0", MINT = "#63e6e2";
const GREEN = "#30d158", YELLOW = "#ffd60a", LEMON = "#ffe066", ORANGE = "#ff9f0a";
const RED = "#ff453a", CORAL = "#ff6961", PINK = "#ff375f", PURPLE = "#bf5af2";
const INDIGO = "#7d7aff", BROWN = "#ac8e68", GREY = "#8e8e93", MUTED = "#aeaeb2";
const WHITE = "#e5e5ea", CLAUDE = "#d97757";

const icon = (svg, color) => ({ svg, color });

const ICON = {
  typescript: icon("seti-typescript", BLUE),
  tsconfig: icon("seti-tsconfig", BLUE),
  react: icon("seti-react", CYAN),
  javascript: icon("seti-javascript", LEMON),
  json: icon("seti-json", YELLOW),
  npm: icon("md-nodejs", GREEN),
  markdown: icon("seti-markdown", BLUE),
  readme: icon("seti-info", BLUE),
  claude: icon("md-asterisk", CLAUDE),
  python: icon("seti-python", YELLOW),
  notebook: icon("seti-notebook", ORANGE),
  go: icon("seti-go", TEAL),
  svelte: icon("seti-svelte", RED),
  vue: icon("seti-vue", GREEN),
  yaml: icon("seti-yml", PURPLE),
  toml: icon("custom-toml", BROWN),
  config: icon("seti-config", GREY),
  env: icon("oct-sliders", YELLOW),
  shell: icon("dev-terminal", GREEN),
  database: icon("seti-db", PINK),
  html: icon("seti-html", ORANGE),
  css: icon("seti-css", BLUE),
  sass: icon("seti-sass", PINK),
  svg: icon("seti-svg", ORANGE),
  image: icon("seti-image", PURPLE),
  video: icon("seti-video", ORANGE),
  audio: icon("seti-audio", PINK),
  font: icon("seti-font", WHITE),
  pdf: icon("seti-pdf", RED),
  word: icon("md-file_word", BLUE),
  excel: icon("md-file_excel", GREEN),
  powerpoint: icon("md-file_powerpoint", CORAL),
  csv: icon("seti-csv", GREEN),
  xml: icon("seti-xml", ORANGE),
  zip: icon("seti-zip", MUTED),
  lock: icon("seti-lock", MUTED),
  git: icon("dev-git", RED),
  docker: icon("seti-docker", BLUE),
  makefile: icon("seti-makefile", ORANGE),
  license: icon("seti-license", YELLOW),
  editorconfig: icon("seti-editorconfig", GREY),
  eslint: icon("seti-eslint", PURPLE),
  prettier: icon("custom-prettier", MINT),
  vite: icon("fa-flash", PURPLE),
  graphql: icon("seti-graphql", PINK),
  jinja: icon("seti-jinja", MUTED),
  rust: icon("seti-rust", BROWN),
  java: icon("seti-java", RED),
  ruby: icon("seti-ruby", RED),
  php: icon("seti-php", PURPLE),
  c: icon("custom-c", BLUE),
  cpp: icon("custom-cpp", PINK),
  csharp: icon("seti-c_sharp", PURPLE),
  kotlin: icon("seti-kotlin", INDIGO),
  swift: icon("seti-swift", ORANGE),
  lua: icon("seti-lua", BLUE),
  terraform: icon("seti-terraform", INDIGO),
  wasm: icon("seti-wasm", INDIGO),
  bruno: icon("md-dog", ORANGE),
  text: icon("seti-text", WHITE),
  file: icon("seti-text", MUTED),
};

// By whole file name, lowercased.
const NAMES = {
  "package.json": ICON.npm,
  "package-lock.json": ICON.npm,
  ".npmrc": ICON.npm,
  "claude.md": ICON.claude,
  "claude.local.md": ICON.claude,
  "agents.md": ICON.claude,
  makefile: ICON.makefile,
  ".gitignore": ICON.git,
  ".gitattributes": ICON.git,
  ".gitmodules": ICON.git,
  ".gitkeep": ICON.git,
  ".dockerignore": { ...ICON.docker, color: MUTED },
  ".editorconfig": ICON.editorconfig,
  "go.mod": ICON.go,
  "go.sum": ICON.lock,
  "requirements.txt": ICON.python,
  ".python-version": ICON.python,
  "pyproject.toml": ICON.python,
};

// Names matched by their shape before the extension is looked at.
const PATTERNS = [
  [/^\.env(\.|$)|\.env$/, ICON.env],
  [/^readme(\.|$)/, ICON.readme],
  [/^(licen[cs]e|copying)(\.|$)/, ICON.license],
  [/^dockerfile|\.dockerfile$/, ICON.docker],
  [/^(docker-)?compose[.\w-]*\.ya?ml$/, ICON.docker],
  [/^tsconfig[.\w-]*\.json$/, ICON.tsconfig],
  [/^vite(st)?\.config\./, ICON.vite],
  [/^eslint\.config\.|^\.eslintrc/, ICON.eslint],
  [/^prettier\.config\.|^\.prettierrc/, ICON.prettier],
];

const byExtension = (icon, extensions) => extensions.split(" ").map(ext => [ext, icon]);

// By extension, lowercased.
const EXTENSIONS = Object.fromEntries([
  ...byExtension(ICON.typescript, "ts mts cts"),
  ...byExtension(ICON.react, "tsx jsx"),
  ...byExtension(ICON.javascript, "js mjs cjs"),
  ...byExtension(ICON.json, "json jsonc json5"),
  ...byExtension(ICON.markdown, "md mdx markdown"),
  ...byExtension(ICON.python, "py pyi"),
  ...byExtension(ICON.notebook, "ipynb"),
  ...byExtension(ICON.go, "go"),
  ...byExtension(ICON.svelte, "svelte"),
  ...byExtension(ICON.vue, "vue"),
  ...byExtension(ICON.yaml, "yml yaml"),
  ...byExtension(ICON.toml, "toml"),
  ...byExtension(ICON.config, "ini cfg conf"),
  ...byExtension(ICON.shell, "sh bash zsh fish"),
  ...byExtension(ICON.database, "sql db sqlite"),
  ...byExtension(ICON.html, "html htm"),
  ...byExtension(ICON.css, "css"),
  ...byExtension(ICON.sass, "scss sass"),
  ...byExtension(ICON.svg, "svg"),
  ...byExtension(ICON.image, "png jpg jpeg gif webp avif ico bmp icns"),
  ...byExtension(ICON.video, "mp4 mov webm"),
  ...byExtension(ICON.audio, "mp3 wav ogg"),
  ...byExtension(ICON.font, "woff woff2 ttf otf"),
  ...byExtension(ICON.pdf, "pdf"),
  ...byExtension(ICON.word, "doc docx"),
  ...byExtension(ICON.excel, "xls xlsx"),
  ...byExtension(ICON.powerpoint, "ppt pptx"),
  ...byExtension(ICON.csv, "csv tsv"),
  ...byExtension(ICON.xml, "xml"),
  ...byExtension(ICON.zip, "zip gz tgz tar"),
  ...byExtension(ICON.lock, "lock"),
  ...byExtension(ICON.graphql, "graphql gql"),
  ...byExtension(ICON.jinja, "jinja j2 mako"),
  ...byExtension(ICON.rust, "rs"),
  ...byExtension(ICON.java, "java"),
  ...byExtension(ICON.ruby, "rb"),
  ...byExtension(ICON.php, "php"),
  ...byExtension(ICON.c, "c h"),
  ...byExtension(ICON.cpp, "cpp hpp"),
  ...byExtension(ICON.csharp, "cs"),
  ...byExtension(ICON.kotlin, "kt"),
  ...byExtension(ICON.swift, "swift"),
  ...byExtension(ICON.lua, "lua"),
  ...byExtension(ICON.terraform, "tf"),
  ...byExtension(ICON.wasm, "wasm"),
  ...byExtension(ICON.bruno, "bru"),
  ...byExtension(ICON.text, "txt"),
  ...byExtension(ICON.file, "log"),
]);

export function fileIcon(name) {
  const lower = name.toLowerCase();
  const known = NAMES[lower] ?? PATTERNS.find(([shape]) => shape.test(lower))?.[1];
  if (known) return known;
  const dot = lower.lastIndexOf(".");
  return (dot > 0 && EXTENSIONS[lower.slice(dot + 1)]) || ICON.file;
}

const folder = (names, svg, color, dim = false) => names.map(name => [name, { svg, color, dim }]);

// Folders with a look of their own, by name lowercased.
const FOLDERS = Object.fromEntries([
  ...folder([".claude"], "md-folder_star", CLAUDE),
  ...folder([".github"], "custom-folder_github", WHITE),
  ...folder([".vscode", ".idea", ".config", "config", "configs", "settings"], "md-folder_cog", MUTED),
  ...folder(["test", "tests", "__tests__", "spec", "e2e"], "md-folder_check", MINT),
  ...folder(["docs", "doc"], "md-folder_text", BLUE),
  ...folder(["scripts", "bin", "tools", "cicd", "ci"], "md-folder_wrench", YELLOW),
  ...folder(["migrations", "alembic", "db", "database", "prisma"], "md-folder_table", PINK),
  ...folder(["public", "assets", "static", "images", "img", "icons"], "md-folder_image", PURPLE),
  ...folder(["contratos", "contracts", "api", "openapi", "compose", "docker"], "md-folder_network", BLUE),
  ...folder(["node_modules"], "custom-folder_npm", RED, true),
  ...folder([".venv", "venv", "__pycache__", "dist", "build", "coverage", ".next", ".svelte-kit",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", ".cache"], "md-folder", GREY, true),
]);

const repoIcon = { svg: "custom-folder_git_branch", color: ORANGE };

// A plain folder opens; one with a look of its own keeps it, as the chevron says open or shut.
export function folderIcon(name, open, repo) {
  const special = FOLDERS[name.toLowerCase()];
  if (special) return special.svg === "md-folder" && open ? { ...special, svg: "md-folder_open" } : special;
  if (repo) return repoIcon;
  return { svg: open ? "md-folder_open" : "md-folder", color: MUTED };
}

// The SVG a row draws for an icon; a dim one is the same glyph, fainter.
export const iconFile = icon =>
  `mods/gonnawork-glass-files/icons/${icon.svg}--${icon.color.slice(1)}${icon.dim ? "-dim" : ""}.svg`;

// Every icon the two functions can answer, for the script that cuts them from the font.
export const ALL_ICONS = [
  ...Object.values(ICON), ...Object.values(NAMES), ...PATTERNS.map(([, icon]) => icon), ...Object.values(FOLDERS),
  repoIcon, { svg: "md-folder", color: MUTED }, { svg: "md-folder_open", color: MUTED },
  { svg: "md-folder_open", color: GREY, dim: true },
];

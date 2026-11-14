#!/usr/bin/env bash
# gonnawork installer: ./install.sh [all|brew|dotfiles|herdr|colima|claude]...
# Safe to run again. Anything it would replace is moved to <file>.backup-<time> first.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
GHOSTTY_DIR="$HOME/Library/Application Support/com.mitchellh.ghostty"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# Moves an existing file aside unless it already is what we're installing.
backup() {
  local dest=$1
  if [[ -L $dest || -e $dest ]]; then
    mv "$dest" "$dest.backup-$STAMP"
    warn "kept your old $(basename "$dest") as $dest.backup-$STAMP"
  fi
}

# Symlinks a repo file into place, so `git pull` updates it.
link() {
  local src="$REPO/$1" dest=$2
  mkdir -p "$(dirname "$dest")"
  [[ -L $dest && "$(readlink "$dest")" == "$src" ]] && return
  backup "$dest"
  ln -s "$src" "$dest"
  say "linked $dest"
}

# Copies a file or folder into place (for apps that write next to their config).
place() {
  local src="$REPO/$1" dest=$2
  mkdir -p "$(dirname "$dest")"
  if [[ -e $dest ]] && diff -rq "$src" "$dest" >/dev/null 2>&1; then return; fi
  backup "$dest"
  cp -R "$src" "$dest"
  say "copied $dest"
}

check_system() {
  [[ $(uname -s) == Darwin ]] || die "gonnawork is for macOS."
  [[ $(uname -m) == arm64 ]] || warn "built on Apple Silicon; Herdr only ships macOS builds for arm64."
  local major; major=$(sw_vers -productVersion | cut -d. -f1)
  (( major >= 14 )) || warn "tested on macOS 15; yours is $(sw_vers -productVersion)."
}

do_brew() {
  if ! command -v brew >/dev/null 2>&1; then
    say "installing Homebrew"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || true)"
  say "installing the Brewfile (this takes a while the first time)"
  brew bundle --file "$REPO/Brewfile"
}

do_dotfiles() {
  link zsh/.zshrc              "$HOME/.zshrc"
  link zsh/.zshenv             "$HOME/.zshenv"
  link starship/starship.toml  "$HOME/.config/starship.toml"
  link fastfetch/config.jsonc  "$HOME/.config/fastfetch/config.jsonc"
  link ghostty/config          "$GHOSTTY_DIR/config.ghostty"
  link glow/glow.yml           "$HOME/Library/Preferences/glow/glow.yml"
  link nvim                    "$HOME/.config/nvim"
}

do_herdr() {
  if [[ ! -f $HERDR/AGENTS.md ]]; then
    warn "open Herdr once (it creates $HERDR), then run: ./install.sh herdr"
    return
  fi
  # Copied, not linked: Herdr writes its own files (types, jsconfig) into mod folders.
  for mod in "$REPO"/herdr/mods/*/; do
    place "herdr/mods/$(basename "$mod")" "$HERDR/mods/$(basename "$mod")"
  done
  place herdr/themes/neon.json            "$HERDR/themes/neon.json"
  place herdr/backgrounds/glass.jpg       "$HERDR/backgrounds/glass.jpg"
  place herdr/layouts/neon.json           "$HERDR/layouts/neon.json"
  place herdr/layouts/neon-blur.json      "$HERDR/layouts/neon-blur.json"
  if command -v herdr-app >/dev/null 2>&1; then
    for mod in "$REPO"/herdr/mods/*/; do
      herdr-app check "$HERDR/mods/$(basename "$mod")" >/dev/null || warn "herdr-app check failed for $(basename "$mod")"
    done
    herdr-app do layout.switch '{"name":"neon"}' >/dev/null 2>&1 && say "Herdr is on the neon layout" || true
  fi
}

do_colima() {
  place colima/colima.yaml "$HOME/.colima/default/colima.yaml"
  say "start Docker's VM with: colima start"
}

do_claude() {
  # Merges claude/settings.json into ~/.claude/settings.json: deny lists are added, nothing removed.
  mkdir -p "$HOME/.claude"
  [[ -f $HOME/.claude/settings.json ]] && cp "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.backup-$STAMP"
  python3 - "$REPO/claude/settings.json" "$HOME/.claude/settings.json" <<'PY'
import json, os, sys
src, dest = sys.argv[1], sys.argv[2]
new = json.load(open(src))
cur = json.load(open(dest)) if os.path.exists(dest) and open(dest).read().strip() else {}
deny = cur.setdefault("permissions", {}).setdefault("deny", [])
for rule in new.get("permissions", {}).get("deny", []):
    if rule not in deny: deny.append(rule)
for k, v in new.items():
    if k == "permissions": continue
    if isinstance(v, dict): cur.setdefault(k, {}).update(v)
    else: cur.setdefault(k, v)
open(dest, "w").write(json.dumps(cur, indent=2) + "\n")
PY
  say "merged Claude Code settings"
}

check_system
targets=("$@")
(( ${#targets[@]} )) || targets=(all)
for t in "${targets[@]}"; do
  case $t in
    all)      do_brew; do_dotfiles; do_herdr; do_colima; do_claude ;;
    brew)     do_brew ;;
    dotfiles) do_dotfiles ;;
    herdr)    do_herdr ;;
    colima)   do_colima ;;
    claude)   do_claude ;;
    *)        die "unknown target: $t (all, brew, dotfiles, herdr, colima, claude)" ;;
  esac
done
say "done. Open a new terminal to load the shell config."

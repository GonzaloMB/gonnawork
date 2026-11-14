# gonnawork · zsh

# Homebrew first, then its unversioned Python commands.
if (( ! $+commands[brew] )) && [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
typeset -U path
path=("$HOME/.local/bin" /opt/homebrew/bin /opt/homebrew/sbin /opt/homebrew/opt/python/libexec/bin "${path[@]}")

(( $+commands[fnm] )) && eval "$(fnm env --use-on-cd --shell zsh)"
(( $+commands[zoxide] )) && eval "$(zoxide init zsh --hook pwd)"
(( $+commands[fzf] )) && source <(fzf --zsh)
(( $+commands[starship] )) && eval "$(starship init zsh)"

alias dev='cd ~/Developer'
alias ls='eza --color=auto --icons=auto --group-directories-first'
alias ll='eza -lah --git'
alias lg='lazygit'
alias ld='lazydocker'
alias gg='tig --all'
alias glog='git log --graph --oneline --decorate --all'
alias dc='docker compose'
alias md='glow -p'

# repos [query]: pick a git repo under $REPOS_ROOT (default ~/Developer) with fzf and cd into it.
# With a query that matches one repo it goes straight there; `repos --list` prints them all.
repos() {
  local root=${REPOS_ROOT:-$HOME/Developer} selected
  local -a list
  [[ -d $root ]] || { print -u2 "repos: $root doesn't exist (set REPOS_ROOT)"; return 1; }
  list=(${(f)"$(fd --hidden --no-ignore --prune --glob .git --exclude node_modules "$root" 2>/dev/null |
    sed -E 's#/\.git/?$##' | sort -u)"})
  (( ${#list} )) || { print -u2 "repos: no git repositories under $root"; return 1; }
  if [[ ${1:-} == --list ]]; then
    print -l -- $list
    return
  fi
  selected=$(print -l -- ${list#$root/} |
    fzf --height=40% --reverse --prompt='repos > ' --query="$*" --select-1 --exit-0) || return
  [[ -n $selected ]] && cd -- "$root/$selected"
}

# fastfetch greets new Ghostty windows (not inside tmux).
if [[ -o interactive && -t 1 && ${TERM_PROGRAM:-} == ghostty && -z ${TMUX:-} ]] && (( $+commands[fastfetch] )); then
  fastfetch
fi

# Machine-specific bits that shouldn't be shared (tokens, work paths...).
[[ -f ~/.zshrc.local ]] && source ~/.zshrc.local

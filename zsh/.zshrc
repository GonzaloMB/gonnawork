# gonnawork · zsh
# z <dir>: jump to a folder you've visited (zoxide); zi: pick one interactively.

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

alias ls='eza --color=auto --icons=auto --group-directories-first'
alias ll='eza -lah --git'
alias lg='lazygit'
alias ld='lazydocker'
alias gg='tig --all'
alias glog='git log --graph --oneline --decorate --all'
alias dc='docker compose'
alias md='glow -p'

# fastfetch greets new Ghostty windows (not inside tmux).
if [[ -o interactive && -t 1 && ${TERM_PROGRAM:-} == ghostty && -z ${TMUX:-} ]] && (( $+commands[fastfetch] )); then
  fastfetch
fi

# Machine-specific bits that shouldn't be shared (tokens, work paths...).
[[ -f ~/.zshrc.local ]] && source ~/.zshrc.local

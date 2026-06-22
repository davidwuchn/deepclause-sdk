#!/bin/zsh
# autojump.zsh - Zsh integration for autojump
# This script provides j, jc, jo, jco shell functions and tab completion

# Locate the autojump binary
if [ -n "$AUTOJUMP_HOME" ] && [ -d "$AUTOJUMP_HOME" ]; then
    _AUTOJUMP_DIR="$AUTOJUMP_HOME"
elif [ -n "$AUTOJUMP_BIN" ]; then
    _AUTOJUMP_DIR="$(dirname "$AUTOJUMP_BIN")"
elif whence -w autojump > /dev/null 2>&1; then
    _AUTOJUMP_DIR="$(dirname "$(whence -w autojump)")"
elif whence -w "$0" > /dev/null 2>&1; then
    _AUTOJUMP_DIR="$(dirname "$(whence -w "$0")")"
else
    _AUTOJUMP_DIR="$(dirname "${(%):-%x}" 2>/dev/null || dirname "$0")"
fi

# Set environment variables
export AUTOJUMP="$0"
export AUTOJUMP_VERSION="22.5.3"
export AUTOJUMP_DATA_FILE="${AUTOJUMP_DATA_FILE:-}"
export AUTOJUMP_COMPLETION="${AUTOJUMP_COMPLETION:-on}"
export AUTOJUMP_SHELL="zsh"

# Tab menu support
if [ -z "$AUTOJUMP_NO_TAB_MENU" ]; then
    export AUTOJUMP_NO_TAB_MENU=0
fi

# Core jump function
_j() {
    local output
    output=$(autojump "$@" 2>/dev/null)
    local status=$?

    if [ $status -eq 0 ] && [ -n "$output" ]; then
        if [[ "$output" == *"autojump: error"* ]] || [[ "$output" == *"No matches"* ]]; then
            return 1
        fi
        # Check if it looks like a tab menu output
        if [[ "$output" == *'$'* ]]; then
            eval "$output"
        else
            cd "$output"
        fi
    fi
    return $status
}

# Jump to directory
j() {
    _j "$@"
}

# Jump to child directory
jc() {
    _j --children "$@"
}

# Open in file manager
jo() {
    local output
    output=$(autojump "$@" 2>/dev/null)
    local status=$?

    if [ $status -eq 0 ] && [ -n "$output" ]; then
        case "$(uname -s)" in
            Darwin)
                open "$output"
                ;;
            Linux)
                if command -v xdg-open > /dev/null 2>&1; then
                    xdg-open "$output"
                elif command -v gnome-open > /dev/null 2>&1; then
                    gnome-open "$output"
                elif command -v kde-open > /dev/null 2>&1; then
                    kde-open "$output"
                elif command -v nautilus > /dev/null 2>&1; then
                    nautilus "$output"
                elif command -v dolphin > /dev/null 2>&1; then
                    dolphin "$output"
                elif command -v thunar > /dev/null 2>&1; then
                    thunar "$output"
                else
                    echo "autojump: no file manager found"
                    return 1
                fi
                ;;
            *)
                echo "autojump: file manager not supported on this platform"
                return 1
                ;;
        esac
    fi
    return $status
}

# Open child directory in file manager
jco() {
    local output
    output=$(autojump --children "$@" 2>/dev/null)
    local status=$?

    if [ $status -eq 0 ] && [ -n "$output" ]; then
        case "$(uname -s)" in
            Darwin)
                open "$output"
                ;;
            Linux)
                if command -v xdg-open > /dev/null 2>&1; then
                    xdg-open "$output"
                elif command -v nautilus > /dev/null 2>&1; then
                    nautilus "$output"
                elif command -v dolphin > /dev/null 2>&1; then
                    dolphin "$output"
                elif command -v thunar > /dev/null 2>&1; then
                    thunar "$output"
                else
                    echo "autojump: no file manager found"
                    return 1
                fi
                ;;
            *)
                echo "autojump: file manager not supported on this platform"
                return 1
                ;;
        esac
    fi
    return $status
}

# Add current directory to autojump database
_j_add() {
    autojump --add "$(pwd -P)" > /dev/null 2>&1
}

# Zsh directory change hook
autoload -U add-zsh-hook
add-zsh-hook chpwd _j_add

# Track directory changes via pushd/popd
pushd() {
    command pushd "$@" && _j_add
}

popd() {
    command popd "$@" && _j_add
}

# Add current directory on load
_j_add

# Zsh tab completion system
autoload -Uz compinit 2>/dev/null

if [ "$AUTOJUMP_COMPLETION" != "off" ]; then
    # Define completion function
    _autojump_completion() {
        local -a matches
        local cur="${words[CURRENT]}"
        local line="${words[1,CURRENT]}"

        # Remove the command itself
        line="${line:${line#* }}"

        # Use autojump --complete for suggestions
        matches=("${(@f)$(autojump --complete ${line} 2>/dev/null)}")

        if (( ${#matches} > 0 )); then
            compadd - "${matches[@]}"
        else
            # Fall back to directory completion
            _directories
        fi
    }

    # Register completions
    compdef _autojump_completion j
    compdef _autojump_completion jc
    compdef _autojump_completion jo
    compdef _autojump_completion jco
fi

# Version function
autojump-version() {
    echo "autojump $AUTOJUMP_VERSION"
}

# Display information
_j_info() {
    echo "autojump $AUTOJUMP_VERSION"
    echo "Data file: $AUTOJUMP_DATA_FILE"
    echo "Shell: zsh"
    echo "Autojump script: $AUTOJUMP"
}

# End of autojump.zsh

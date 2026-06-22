#!/bin/bash
# autojump.bash - Bash integration for autojump
# This script provides j, jc, jo, jco shell functions and tab completion

# Locate the autojump binary
if [ -n "$AUTOJUMP_HOME" ] && [ -d "$AUTOJUMP_HOME" ]; then
    _AUTOJUMP_DIR="$AUTOJUMP_HOME"
elif [ -n "$AUTOJUMP_BIN" ]; then
    _AUTOJUMP_DIR="$(dirname "$AUTOJUMP_BIN")"
elif type -p autojump > /dev/null 2>&1; then
    _AUTOJUMP_DIR="$(dirname "$(type -p autojump)")"
elif type -p "$0" > /dev/null 2>&1; then
    _AUTOJUMP_DIR="$(dirname "$(type -p "$0")")"
else
    _AUTOJUMP_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")" 2>/dev/null || dirname "$0")"
fi

# Set environment variables
export AUTOJUMP="$0"
export AUTOJUMP_VERSION="22.5.3"
export AUTOJUMP_DATA_FILE="${AUTOJUMP_DATA_FILE:-}"
export AUTOJUMP_COMPLETION="${AUTOJUMP_COMPLETION:-on}"
export AUTOJUMP_SHELL="bash"

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
        if [[ "$output" == *"$" ]]; then
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
                elif command -v gnome-open > /dev/null 2>&1; then
                    gnome-open "$output"
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

# Track directory changes via cd hook
_j_cd() {
    command cd "$@" && _j_add
}

# Override cd with hook
alias cd='_j_cd'

# Track directory changes via pushd hook
_j_pushd() {
    command pushd "$@" > /dev/null 2>&1 && _j_add
}
alias pushd='_j_pushd'

# Track directory changes via popd hook
_j_popd() {
    command popd "$@" > /dev/null 2>&1 && _j_add
}
alias popd='_j_popd'

# Add current directory on load
_j_add

# Tab completion
if [ "$AUTOJUMP_COMPLETION" != "off" ]; then
    # Use _j helper for tab completion
    complete -F _autojump_completion j 2>/dev/null
    complete -F _autojump_completion jc 2>/dev/null
    complete -F _autojump_completion jo 2>/dev/null
    complete -F _autojump_completion jco 2>/dev/null

    _autojump_completion() {
        local cur="${COMP_WORDS[COMP_CWORD]}"
        local prev="${COMP_WORDS[COMP_CWORD-1]}"
        local words=("${COMP_WORDS[@]:0:COMP_CWORD}")

        # Use --complete for tab completion
        local output
        output=$(autojump --complete "${words[@]}" 2>/dev/null)

        if [ $? -eq 0 ] && [ -n "$output" ]; then
            # Parse tab completion output
            local matches=()
            while IFS= read -r line; do
                if [ -n "$line" ]; then
                    matches+=("$line")
                fi
            done <<< "$output"

            if [ ${#matches[@]} -gt 0 ]; then
                COMPREPLY=("${matches[@]}")
            fi
        fi
    }
fi

# Version function
autojump-version() {
    echo "autojump $AUTOJUMP_VERSION"
}

# Display information
_j_info() {
    echo "autojump $AUTOJUMP_VERSION"
    echo "Data file: $AUTOJUMP_DATA_FILE"
    echo "Shell: bash"
    echo "Autojump script: $AUTOJUMP"
}

# End of autojump.bash

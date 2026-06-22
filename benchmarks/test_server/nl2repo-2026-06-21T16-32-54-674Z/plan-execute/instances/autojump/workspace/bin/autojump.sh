# autojump - Smart file system navigation tool
# This script is loaded by shell-specific scripts (autojump.bash, autojump.zsh, etc.)

# Autojump initialization
_AUTOJUMP_SH_LOADED=1

# Detect autojump binary location
if command -v autojump >/dev/null 2>&1; then
    AUTOJUMP_HOME="$(dirname "$(command -v autojump)")"
elif [ -n "$AUTOJUMP_PATH" ]; then
    AUTOJUMP_HOME="$AUTOJUMP_PATH"
fi

# Export autojump environment variables
export AUTOJUMP_PATH="${AUTOJUMP_PATH:-${AUTOJUMP_HOME}}"
export AUTOJUMP_SHARE="${AUTOJUMP_SHARE:-${AUTOJUMP_HOME}/..}"
export AUTOJUMP_DATA="${AUTOJUMP_DATA:-}"

# Platform-specific file manager detection
_open_autojump_dir() {
    local dir="$1"
    if [ -z "$dir" ]; then
        return 1
    fi

    case "$(uname -s)" in
        Darwin)
            open "$dir"
            ;;
        Linux)
            if command -v xdg-open >/dev/null 2>&1; then
                xdg-open "$dir"
            elif command -v nautilus >/dev/null 2>&1; then
                nautilus "$dir"
            elif command -v dolphin >/dev/null 2>&1; then
                dolphin "$dir"
            elif command -v thunar >/dev/null 2>&1; then
                thunar "$dir"
            fi
            ;;
        MINGW*|CYGWIN*|MSYS*)
            explorer "$dir"
            ;;
        *)
            echo "No file manager found for platform $(uname -s)"
            return 1
            ;;
    esac
}

# Core autojump function (called by shell-specific wrappers)
_autojump_core() {
    local query="$*"
    local args=()

    if [ -z "$query" ]; then
        return 1
    fi

    # Execute autojump with the query
    local result
    result=$(autojump "$query" 2>/dev/null)
    local status=$?

    if [ $status -ne 0 ]; then
        echo "autojump: could not find directory matching '$query'" >&2
        return 1
    fi

    echo "$result"
    return 0
}

# Version information
_autojump_version() {
    autojump --version 2>/dev/null || echo "autojump 22.5.3"
}

# autojump.fish - Fish shell integration for autojump
# This script provides j, jc, jo, jco shell functions and tab completion

# Set environment variables
set -gx AUTOJUMP_VERSION "22.5.3"
set -gx AUTOJUMP_SHELL "fish"
set -gx AUTOJUMP_COMPLETION "$AUTOJUMP_COMPLETION"
if not set -q AUTOJUMP_COMPLETION
    set -gx AUTOJUMP_COMPLETION "on"
end

# Tab menu support
if not set -q AUTOJUMP_NO_TAB_MENU
    set -gx AUTOJUMP_NO_TAB_MENU 0
end

# Locate the autojump binary
if set -q AUTOJUMP_BIN
    set _AUTOJUMP_DIR (dirname "$AUTOJUMP_BIN")
else if type -q autojump
    set _AUTOJUMP_DIR (dirname (type -fp autojump))
else if type -q "$argv[1]"
    set _AUTOJUMP_DIR (dirname (type -fp "$argv[1]"))
else
    set _AUTOJUMP_DIR (dirname (status filename) 2>/dev/null || dirname (status current-file))
end

# Locate the autojump.sh helper
if set -q AUTOJUMP_PATH
    set AUTOJUMP_DATA_FILE "$AUTOJUMP_PATH"
end

# Core jump function
function _j -d "Core autojump function"
    set output (autojump $argv 2>/dev/null)
    set status $status

    if test $status -eq 0 -a -n "$output"
        if string match -q '*autojump: error*' "$output" \
            -o '*No matches*' "$output"
            return 1
        end
        # Check if it looks like a tab menu output
        if string match -q '*\$' "$output"
            eval "$output"
        else
            cd "$output"
        end
    end
    return $status
end

# Jump to directory
function j -d "Jump to a directory using autojump"
    _j $argv
end

# Jump to child directory
function jc -d "Jump to a child directory using autojump"
    _j --children $argv
end

# Open in file manager
function jo -d "Open a directory in the file manager"
    set output (autojump $argv 2>/dev/null)
    set status $status

    if test $status -eq 0 -a -n "$output"
        switch (uname -s)
            case Darwin
                open "$output"
            case Linux
                if type -q xdg-open
                    xdg-open "$output"
                else if type -q nautilus
                    nautilus "$output"
                else if type -q dolphin
                    dolphin "$output"
                else if type -q thunar
                    thunar "$output"
                else
                    echo "autojump: no file manager found"
                    return 1
                end
            case '*'
                echo "autojump: file manager not supported on this platform"
                return 1
        end
    end
    return $status
end

# Open child directory in file manager
function jco -d "Open a child directory in the file manager"
    set output (autojump --children $argv 2>/dev/null)
    set status $status

    if test $status -eq 0 -a -n "$output"
        switch (uname -s)
            case Darwin
                open "$output"
            case Linux
                if type -q xdg-open
                    xdg-open "$output"
                else if type -q nautilus
                    nautilus "$output"
                else if type -q dolphin
                    dolphin "$output"
                else if type -q thunar
                    thunar "$output"
                else
                    echo "autojump: no file manager found"
                    return 1
                end
            case '*'
                echo "autojump: file manager not supported on this platform"
                return 1
        end
    end
    return $status
end

# Add current directory to autojump database
function _j_add -d "Add current directory to autojump database"
    autojump --add (pwd) > /dev/null 2>&1
end

# Track directory changes via fish_prompt and fish_cd hooks
function _j_on_cd --on-variable PWD
    _j_add
end

# Add current directory on load
_j_add

# Tab completion
if test "$AUTOJUMP_COMPLETION" != "off"
    # Complete for j
    complete -c j -n '__fish_use_subcommand' -f -a "(autojump --complete (commandline -ct) 2>/dev/null)"
    complete -c j -n "__fish_seen_subcommand_from" -f -a "(autojump --complete (commandline -ct) 2>/dev/null)"

    # Complete for jc
    complete -c jc -n '__fish_use_subcommand' -f -a "(autojump --complete --children (commandline -ct) 2>/dev/null)"
    complete -c jc -n "__fish_seen_subcommand_from" -f -a "(autojump --complete --children (commandline -ct) 2>/dev/null)"

    # Complete for jo
    complete -c jo -n '__fish_use_subcommand' -f -a "(autojump --complete (commandline -ct) 2>/dev/null)"
    complete -c jo -n "__fish_seen_subcommand_from" -f -a "(autojump --complete (commandline -ct) 2>/dev/null)"

    # Complete for jco
    complete -c jco -n '__fish_use_subcommand' -f -a "(autojump --complete --children (commandline -ct) 2>/dev/null)"
    complete -c jco -n "__fish_seen_subcommand_from" -f -a "(autojump --complete --children (commandline -ct) 2>/dev/null)"
end

# Version function
function autojump-version -d "Print autojump version"
    echo "autojump $AUTOJUMP_VERSION"
end

# Display information
function _j_info -d "Print autojump information"
    echo "autojump $AUTOJUMP_VERSION"
    echo "Data file: $AUTOJUMP_DATA_FILE"
    echo "Shell: fish"
    echo "Autojump script: (status filename)"
end

# End of autojump.fish

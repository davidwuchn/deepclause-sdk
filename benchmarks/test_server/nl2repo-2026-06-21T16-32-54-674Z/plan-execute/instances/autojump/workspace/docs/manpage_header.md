autojump(1) - Smart file system navigation
============================================

## NAME

autojump - A fast file system navigation tool

## SYNOPSIS

autojump [OPTIONS] [QUERY]

## DESCRIPTION

autojump is a smart file system navigation tool that enables users to quickly jump to target directories by maintaining a database of frequently accessed directories. It performs exceptionally well in the command-line environment, offering intelligent path matching with fuzzy matching, consecutive matching, and matching at any position.

## OPTIONS

- **-a, --add PATH**: Add a directory path to the database
- **-i, --increase WEIGHT**: Increase weight for current directory (default: 10)
- **-d, --decrease WEIGHT**: Decrease weight for current directory (default: 15)
- **--complete**: Tab completion mode
- **--purge**: Remove non-existent paths from database
- **-s, --stat**: Show database statistics
- **-h, --help**: Show help message
- **--version**: Show version number

## SHELL COMMANDS

- **j QUERY**: Jump to directory matching QUERY
- **jc QUERY**: Jump to child directory matching QUERY
- **jo QUERY**: Open directory matching QUERY in file manager
- **jco QUERY**: Open child directory matching QUERY in file manager

## FILES

- **~/.local/share/autojump/autojump.txt**: Default data file on Linux
- **~/Library/autojump/autojump.txt**: Default data file on macOS
- **%APPDATA%/autojump/autojump.txt**: Default data file on Windows

## ENVIRONMENT

- **AUTOJUMP_PATH**: Path to autojump installation
- **AUTOJUMP_DATA_FILE**: Path to data file
- **AUTOJUMP_DEBUG**: Debug mode (set to 1)

## SEE ALSO

j(1), jc(1), jo(1), autojump.bash(1), autojump.zsh(1)

## AUTHOR

William Ting and the autojump community. MIT License.

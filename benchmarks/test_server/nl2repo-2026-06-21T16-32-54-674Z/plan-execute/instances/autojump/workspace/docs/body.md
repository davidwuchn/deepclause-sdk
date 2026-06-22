## COMMANDS

### j [query]
The core command used to quickly jump to a matching directory. Searches the database for directories matching the query and changes to the highest-weighted result.

```bash
j project          # Jump to directory matching "project"
j my project       # Jump to directory matching both "my" and "project"
j PROJ             # Case-sensitive match (uppercase in query)
```

### jc [query]
Variant of `j` that prefers child directories (subdirectories of the current directory). Useful when you want to navigate deeper into your current project structure.

```bash
jc src             # Jump to src subdirectory
jc build           # Jump to build subdirectory
```

### jo [query]
Opens the matching directory in your system's file manager instead of changing the shell directory.

```bash
jo documents       # Open documents in file manager
jo photos          # Open photos in file manager
```

### jco [query]
Combines `jc` and `jo` - prefers child directories and opens them in the file manager.

```bash
jco screenshots    # Open child screenshots dir in file manager
```

## OPTIONS

### autojump command options

- `-a, --add PATH` : Add a directory path to the database
- `-i, --increase WEIGHT` : Increase weight for current directory (default: 10)
- `-d, --decrease WEIGHT` : Decrease weight for current directory (default: 15)
- `--complete` : Tab completion mode (used internally by shell scripts)
- `--purge` : Remove non-existent paths from the database
- `-s, --stat` : Show database statistics (top 10 directories)
- `-h, --help` : Show help message and exit
- `--version` : Show version number and exit

## SHELL SUPPORT

autojump supports the following shell environments:

- **Bash** (version 3.0+)
- **Zsh** (version 4.0+)
- **Fish** (version 2.0+)
- **Tcsh**
- **Windows CMD** (via batch files)

## MATCHING ALGORITHMS

autojump uses three matching algorithms, applied in order of preference:

1. **Anywhere Matching**: Patterns can appear at any position in the path. Patterns must appear in the same order but not necessarily consecutively.

2. **Consecutive Matching**: Patterns must appear consecutively in the path. For example, `['foo', 'baz']` matches paths ending with `/.../foo/.../baz`.

3. **Fuzzy Matching**: Uses edit distance (Levenshtein distance) to find similar paths. Useful for typos or approximate matching.

## TAB COMPLETION

Press Tab twice to see a menu of matched directories:

```bash
j pro<TAB><TAB>
  1: /home/user/projects
  2: /home/user/work/project
  3: /var/www/project
```

Select a number to jump to that directory.

## WEIGHT SYSTEM

Each directory in the database has a weight that determines its ranking:

- Every time you access a directory, its weight increases
- Weight formula: `new_weight = sqrt(old_weight^2 + increment^2)`
- Default increment: 15
- Directories with higher weights appear first in search results

## INSTALLATION

### Using pip
```bash
pip install autojump
```

### Manual installation
```bash
python install.py
```

### System-wide installation
```bash
sudo python install.py --system
```

## DATA FILE LOCATION

| Platform | Default Path |
|----------|-------------|
| Linux | `~/.local/share/autojump/autojump.txt` |
| macOS | `~/Library/autojump/autojump.txt` |
| Windows | `%APPDATA%/autojump/autojump.txt` |

## ENVIRONMENT VARIABLES

- `AUTOJUMP_PATH` : Override the autojump installation path
- `AUTOJUMP_DATA_FILE` : Override the data file path
- `AUTOJUMP_DEBUG` : Set to 1 for debug output

## UNINSTALLATION

```bash
python uninstall.py
python uninstall.py --userdata  # Also remove user data
```

## EXAMPLES

```bash
# Basic usage
j work
j home projects

# Prefer subdirectories
jc src
jc tests

# Open in file manager
jo downloads

# View statistics
j -s

# Purge invalid entries
j --purge
```

## SEE ALSO

- `autojump(1)` - Man page
- `install.py` - Installation script
- `uninstall.py` - Uninstallation script

## AUTHOR

William Ting <wbting1@gmail.com> and the autojump community

## LICENSE

MIT License. See LICENSE file for details.

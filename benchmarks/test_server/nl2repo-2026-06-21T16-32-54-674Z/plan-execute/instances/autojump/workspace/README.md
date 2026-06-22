# autojump

[![Build Status](https://travis-ci.org/wting/autojump.svg?branch=master)](https://travis-ci.org/wting/autojump)
[![PyPI version](https://badge.fury.io/py/autojump.svg)](https://badge.fury.io/py/autojump)

**autojump** is a faster way to navigate the terminal by maintaining a database of the directories you access most frequently from the command line. It allows you to jump to frequently used directories with just a few keystrokes.

## Quick Start

```bash
# Install
python install.py

# In your shell (bash/zsh/fish/tcsh), the j command is automatically available
j project    # Jump to a directory containing "project"
jc src       # Jump to a child directory containing "src"
jo docs      # Open "docs" in your file manager
```

## Features

- **Intelligent path matching**: Fuzzy matching, consecutive matching, and anywhere matching
- **Weighted directory sorting**: Directories you visit most often appear first
- **Multiple shell support**: Bash, Zsh, Fish, Tcsh, and Windows CMD
- **Cross-platform**: Works on Linux, macOS, and Windows
- **Tab completion**: Press Tab to see a menu of matched directories
- **Child directory preference**: Use `jc` to prefer subdirectories

## Installation

### Using pip
```bash
pip install autojump
```

### Manual Installation
```bash
git clone https://github.com/wting/autojump.git
cd autojump
python install.py
```

### For All Users (System-wide)
```bash
sudo python install.py --system
```

### Manual Setup
If automatic setup fails, add the following to your shell config:

**Bash** (`~/.bashrc`):
```bash
[[ -s /usr/share/autojump/autojump.bash ]] && source /usr/share/autojump/autojump.bash
```

**Zsh** (`~/.zshrc`):
```bash
[[ -s /usr/share/autojump/autojump.zsh ]] && source /usr/share/autojump/autojump.zsh
```

**Fish** (`~/.config/fish/config.fish`):
```bash
source /usr/share/autojump/autojump.fish
```

**Tcsh** (`~/.tcshrc`):
```bash
source /usr/share/autojump/autojump.tcsh
```

## Usage

### Basic Commands

| Command | Description |
|---------|-------------|
| `j foo` | Jump to directory matching "foo" |
| `jc foo` | Jump to child directory matching "foo" |
| `jo foo` | Open directory matching "foo" in file manager |
| `jco foo` | Open child directory matching "foo" in file manager |

### Advanced Usage

```bash
# Multi-word matching
j my project      # Jump to directory matching "my" AND "project"

# Case-sensitive matching (when pattern has uppercase)
j MyProject       # Case-sensitive search for "MyProject"

# Tab completion menu
j foo<TAB><TAB>   # Show interactive menu of matches

# View statistics
j -s              # Show top 10 most visited directories

# Purge non-existent directories from database
j --purge
```

## How It Works

Autojump maintains a database of directories you visit, with each directory having a weight score. The weight increases every time you access a directory. When you use `j` to navigate, autojump matches your search terms against the database and sorts results by weight, so the most frequently accessed directories appear first.

- **Anywhere matching**: Patterns can appear anywhere in the path
- **Consecutive matching**: Patterns must appear consecutively
- **Fuzzy matching**: Uses edit distance for fuzzy pattern matching

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AUTOJUMP_PATH` | Path to the autojump installation |
| `AUTOJUMP_DATA_FILE` | Custom path for the data file |
| `AUTOJUMP_DEBUG` | Set to 1 to enable debug output |

### Data File Location

| Platform | Default Location |
|----------|-----------------|
| Linux | `~/.local/share/autojump/autojump.txt` |
| macOS | `~/Library/autojump/autojump.txt` |
| Windows | `%APPDATA%/autojump/autojump.txt` |

## Uninstall

```bash
python uninstall.py           # Remove installation
python uninstall.py --userdata  # Also remove user data
```

## Requirements

- Python 2.6+ or Python 3.3+
- No external dependencies (uses only Python standard library)

## Project Structure

```
autojump/
├── bin/                    # Core modules and shell scripts
│   ├── autojump            # Main executable wrapper
│   ├── autojump.py         # Main logic
│   ├── autojump_data.py    # Database management
│   ├── autojump_match.py   # Path matching algorithms
│   ├── autojump_utils.py   # Utility functions
│   ├── autojump_argparse.py # Argument parsing
│   ├── autojump.bash       # Bash integration
│   ├── autojump.zsh        # Zsh integration
│   ├── autojump.fish       # Fish integration
│   ├── autojump.tcsh       # Tcsh integration
│   └── ...
├── docs/                   # Documentation
├── tools/                  # Additional tools
│   └── autojump_ipython.py # IPython magic
├── install.py              # Installation script
├── uninstall.py            # Uninstallation script
└── pyproject.toml          # Project metadata
```

## License

MIT License. See [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests.

## Authors

See [AUTHORS](AUTHORS) for the list of contributors.

## Changelog

See [CHANGES.md](CHANGES.md) for release history.

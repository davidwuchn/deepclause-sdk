# Autojump Installation Guide

## Prerequisites

- Python 2.6+ or Python 3.3+
- No external dependencies required (uses only Python standard library)

## Installation Methods

### Method 1: Using pip (Recommended)

```bash
pip install autojump
```

### Method 2: Using install.py

```bash
# Clone the repository
git clone https://github.com/wting/autojump.git
cd autojump

# Install for current user
python install.py

# Install system-wide (requires root)
sudo python install.py --system

# Dry run (no changes)
python install.py --dryrun
```

### Method 3: Manual Installation

If the installation script doesn't work, you can manually add autojump to your shell configuration:

#### Bash

Add to `~/.bashrc`:
```bash
export AUTOJUMP_PATH="/path/to/autojump"
export AUTOJUMP_DATA_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/autojump/autojump.txt"
[[ -s $AUTOJUMP_PATH/autojump.bash ]] && source $AUTOJUMP_PATH/autojump.bash
```

#### Zsh

Add to `~/.zshrc`:
```bash
export AUTOJUMP_PATH="/path/to/autojump"
export AUTOJUMP_DATA_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/autojump/autojump.txt"
[[ -s $AUTOJUMP_PATH/autojump.zsh ]] && source $AUTOJUMP_PATH/autojump.zsh
```

#### Fish

Add to `~/.config/fish/config.fish`:
```fish
set -x AUTOJUMP_PATH /path/to/autojump
set -x AUTOJUMP_DATA_FILE $HOME/.local/share/autojump/autojump.txt
source $AUTOJUMP_PATH/autojump.fish
```

#### Tcsh

Add to `~/.tcshrc`:
```tcsh
setenv AUTOJUMP_PATH "/path/to/autojump"
setenv AUTOJUMP_DATA_FILE "$HOME/.local/share/autojump/autojump.txt"
source $AUTOJUMP_PATH/autojump.tcsh
```

## Installation Options

| Option | Description |
|--------|-------------|
| `--dryrun` | Simulate installation without making changes |
| `--force` | Skip validation checks |
| `--system` | Install system-wide for all users |
| `--destdir DIR` | Custom destination directory |
| `--prefix DIR` | Custom prefix directory |
| `--zshshare DIR` | Custom Zsh share directory |
| `--clinkdir DIR` | Custom Clink directory (Windows) |

## Post-Installation

After installation, you need to start a new shell session or source your shell configuration file to activate autojump:

```bash
# For bash
source ~/.bashrc

# For zsh
source ~/.zshrc
```

## Verifying Installation

```bash
# Check the autojump binary
which autojump

# Check version
autojump --version

# Check the j function (in your shell)
type j
```

## Troubleshooting

### "j: command not found"

Make sure you've sourced the autojump shell script. Add the appropriate source line to your shell config file as shown above.

### Database not found

The database is created automatically on first use. If needed, you can set a custom path:
```bash
export AUTOJUMP_DATA_FILE="/path/to/your/autojump.txt"
```

### Permission denied

If you encounter permission errors, try:
```bash
# For system-wide installation
sudo chown -R $USER:$USER ~/.local/share/autojump
```

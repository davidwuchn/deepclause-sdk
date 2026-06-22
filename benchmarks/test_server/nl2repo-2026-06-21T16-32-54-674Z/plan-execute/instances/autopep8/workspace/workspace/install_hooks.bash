#!/bin/bash
# Install git hooks for autopep8

HOOKS_DIR="$(git rev-parse --git-dir)/hooks"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing git hooks..."

for hook in "$SCRIPT_DIR/hooks/"*; do
    hook_name=$(basename "$hook")
    cp "$hook" "$HOOKS_DIR/$hook_name"
    chmod +x "$HOOKS_DIR/$hook_name"
    echo "Installed $hook_name"
done

echo "Git hooks installed successfully!"

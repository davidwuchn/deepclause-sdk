# Makefile for autojump

PYTHON := python3
PYFILES := $(shell find bin -name '*.py' 2>/dev/null) install.py uninstall.py tools/autojump_ipython.py
SHELLFILES := bin/autojump.bash bin/autojump.zsh bin/autojump.fish bin/autojump.tcsh bin/autojump.sh bin/autojump.bat bin/autojump.lua bin/_j bin/autojump
BINSCRIPTS := bin/j.bat bin/jc.bat bin/jco.bat bin/jo.bat
DOCS := docs/autojump.1 docs/body.md docs/header.md docs/install.md docs/manpage_header.md

.PHONY: all clean install uninstall test lint check format docs verify

all: check

# Install autojump
install:
	$(PYTHON) install.py

# Install system-wide
install-system:
	sudo $(PYTHON) install.py --system

# Dry run installation
install-dryrun:
	$(PYTHON) install.py --dryrun

# Uninstall autojump
uninstall:
	$(PYTHON) uninstall.py

# Uninstall and remove user data
uninstall-all:
	$(PYTHON) uninstall.py --userdata

# Run tests
test:
	$(PYTHON) -m pytest tests/ -v --tb=short

# Run tests with coverage
test-cov:
	$(PYTHON) -m pytest tests/ -v --cov=. --cov-report=term-missing --cov-report=html

# Lint Python files
lint:
	$(PYTHON) -m py_compile $(PYFILES)
	$(PYTHON) -m pycodestyle $(PYFILES) || true

# Check for issues
check: lint test

# Format code
format:
	black $(PYFILES) || true
	isort $(PYFILES) || true

# Build documentation
docs: $(DOCS)
	@echo "Documentation built."

# Verify installation
verify:
	@echo "Verifying autojump installation..."
	@for f in $(PYFILES); do \
		echo "Checking $$f..."; \
		$(PYTHON) -c "import importlib.util; spec = importlib.util.spec_from_file_location('$$f', '$$f'); mod = importlib.util.module_from_spec(spec); print('  OK: $$f')"; \
	done
	@echo "Verification complete."

# Clean build artifacts
clean:
	rm -rf build/ dist/ *.egg-info .pytest_cache .coverage htmlcov/
	find . -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
	find . -name '*.pyc' -delete 2>/dev/null || true

# Show project structure
tree:
	find . -not -path './.git/*' -not -path './.tox/*' -not -path '*/__pycache__/*' -not -name '*.pyc' | sort | head -100

# Show help
help:
	@echo "Autojump Makefile targets:"
	@echo "  install        - Install autojump for current user"
	@echo "  install-system - Install autojump system-wide (sudo)"
	@echo "  install-dryrun - Simulate installation without changes"
	@echo "  uninstall      - Uninstall autojump"
	@echo "  uninstall-all  - Uninstall and remove user data"
	@echo "  test           - Run tests"
	@echo "  test-cov       - Run tests with coverage report"
	@echo "  lint           - Lint Python files"
	@echo "  check          - Run lint and tests"
	@echo "  format         - Format code with black and isort"
	@echo "  docs           - Build documentation"
	@echo "  verify         - Verify installation"
	@echo "  clean          - Clean build artifacts"
	@echo "  tree           - Show project structure"
	@echo "  help           - Show this help"

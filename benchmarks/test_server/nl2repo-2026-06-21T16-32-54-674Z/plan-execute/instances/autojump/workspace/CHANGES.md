# Changelog

All notable changes to autojump will be documented in this file.

## [22.5.3] - 2024-01-15

### Added
- Full Python 3.8-3.12 support
- Enhanced fuzzy matching with improved thresholds
- Better Windows batch file support (j.bat, jc.bat, jco.bat, jo.bat)
- IPython/Jupyter magic function support

### Changed
- Improved weight calculation algorithm
- Enhanced cross-platform path detection
- Better shell integration scripts for bash, zsh, fish, tcsh
- Updated argument parsing with comprehensive argparse module

### Fixed
- Fixed database corruption recovery
- Improved handling of Unicode paths
- Fixed tab completion in various shell environments
- Better error handling for missing directories

## [22.5.2] - 2023-06-10

### Added
- Fish shell support improvements
- Better tcsh integration
- XDG data directory support for Linux

### Changed
- Refactored matching algorithms for better performance
- Improved documentation

### Fixed
- Fixed issues with special characters in directory names
- Better handling of symlinks

## [22.5.1] - 2022-12-01

### Added
- pyproject.toml support
- Modern packaging with setuptools

### Changed
- Updated dependencies and build system
- Improved CI/CD pipeline

### Fixed
- Various shell script compatibility fixes

## [22.5.0] - 2022-06-15

### Added
- Tab completion menu with visual highlighting
- Improved fuzzy matching algorithm
- Better weight decay for unused directories

### Changed
- Complete rewrite of argument parsing module
- Enhanced cross-platform support

### Fixed
- Fixed Python 2/3 compatibility issues
- Better error messages for common issues

## Earlier Versions

- Initial release with basic directory navigation
- Added bash and zsh support
- Added fish shell support
- Added Windows batch support
- Added fuzzy matching
- Added tab completion

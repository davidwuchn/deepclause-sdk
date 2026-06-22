"""Allow running as ``python -m arguably`` — no-integration mode.

When a Python script is passed as an argument, Arguably dynamically loads it,
auto-discovers callable functions and classes, registers them as subcommands,
and dispatches the parsed CLI arguments to the correct target.

Usage examples::

    python -m arguably my_script.py --help
    python -m arguably my_script.py hello World
    python -m arguably my_script.py --debug hello World
"""

import argparse
import importlib.util
import inspect
import sys
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from arguably._util import (
    camel_case_to_kebab_case,
    get_callable_methods,
    normalize_name,
)


def _discover_callables(module) -> List[Tuple[str, int, Callable]]:
    """Discover all top-level callables in a module.

    Returns a list of (display_name, lineno, callable) tuples ordered by
    their line number in the source file so that the CLI preserves
    declaration order.
    """
    results: Dict[str, Tuple[int, Callable]] = {}

    for name in dir(module):
        if name.startswith("_"):
            continue
        obj = getattr(module, name)
        if not callable(obj):
            continue
        # Skip built-in types and imported modules
        if hasattr(obj, "__module__") and obj.__module__ != module.__name__:
            continue

        try:
            _, lineno = inspect.getsourcelines(obj)
        except (OSError, TypeError):
            lineno = 0

        # Use kebab-case for CLI display names
        cli_name = camel_case_to_kebab_case(name)

        if inspect.isclass(obj):
            # Register the class (its __init__) as a command
            results[cli_name] = (lineno, obj)

            # Register each public method as a nested subcommand
            methods = get_callable_methods(obj)
            for method in methods:
                try:
                    m_name = method.__name__
                except AttributeError:
                    if hasattr(method, "__func__"):
                        m_name = method.__func__.__name__
                    else:
                        continue
                m_cli = camel_case_to_kebab_case(m_name)
                sub_name = f"{cli_name}.{m_cli}"
                try:
                    _, m_lineno = inspect.getsourcelines(method)
                except (OSError, TypeError):
                    m_lineno = lineno
                results[sub_name] = (m_lineno, method)
        else:
            results[cli_name] = (lineno, obj)

    # Sort by line number to preserve declaration order
    sorted_results = sorted(results.items(), key=lambda kv: kv[1][0])
    return [(name, _, func) for name, (_, func) in sorted_results]


def _wrap_callable(func: Callable, new_name: str, doc: Optional[str] = None) -> Callable:
    """Wrap a callable (function, method, or class) so it has the desired
    ``__name__`` and ``__doc__`` for command registration."""
    # Get the underlying function for bound/unbound methods
    underlying = func
    if hasattr(func, "__func__"):
        underlying = func.__func__

    @wraps(underlying)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)

    wrapper.__name__ = new_name
    if doc is not None:
        wrapper.__doc__ = doc
    return wrapper


def _no_integration_run(
    file: Path,
    argv: List[str],
    debug: bool = False,
    no_warn: bool = False,
) -> Any:
    """Run a script in no-integration mode: auto-discover and register commands.

    1. Dynamically loads *file* as a module.
    2. Discovers all public functions and classes.
    3. Registers each discovery as an ``@arguably.command``.
    4. Invokes ``arguably.run()`` with ``always_subcommand=True`` and
       ``strict=False`` so that the user script never needs to import
       or use Arguably at all.

    Returns the result of the executed command, or ``None``.
    """
    import arguably

    # Load the target script as a module
    module_name = file.stem
    spec = importlib.util.spec_from_file_location(module_name, file)
    if spec is None or spec.loader is None:
        print(f"Error: could not load module from {file}", file=sys.stderr)
        sys.exit(2)

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module

    try:
        spec.loader.exec_module(module)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"Error loading {file}: {exc}", file=sys.stderr)
        sys.exit(2)

    # Discover all callables in the loaded module
    callables = _discover_callables(module)

    if not callables:
        if debug:
            print(f"Warning: no public callables found in {file}", file=sys.stderr)
        return None

    # Register each callable as a command
    for cli_name, lineno, func in callables:
        # Use _wrap_callable to ensure the wrapped function has the desired
        # __name__ (which CommandDecoratorInfo uses for the CLI command name)
        doc = None
        if hasattr(func, "__doc__") and func.__doc__:
            doc = func.__doc__
        elif inspect.isclass(func) and func.__doc__:
            doc = func.__doc__

        wrapped = _wrap_callable(func, cli_name, doc)
        arguably.command(wrapped)

    # Set sys.argv to what arguably.run() should see
    new_argv = [module_name] + argv
    sys.argv = new_argv

    # Run with strict=False for no-integration mode (spec requirement)
    return arguably.run(
        name=module_name,
        always_subcommand=True,
        strict=not no_warn,
        show_defaults=True,
        show_types=True,
    )


def _main_entry() -> None:
    """Parse CLI arguments for ``python -m arguably`` and dispatch."""

    parser = argparse.ArgumentParser(
        prog="arguably",
        description=(
            "Run a Python script with an automatically generated CLI.\n"
            "No changes to the script are required."
        ),
    )
    parser.add_argument(
        "script",
        metavar="SCRIPT",
        help="Path to the Python script to auto-wrap with a CLI.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        default=False,
        help="Enable debug mode (print extra information).",
    )
    parser.add_argument(
        "--no-warn",
        action="store_true",
        default=False,
        help="Disable all Arguably warnings.",
    )
    parser.add_argument(
        "args",
        nargs=argparse.REMAINDER,
        help="Arguments forwarded to the script's auto-generated CLI.",
    )

    raw_args = parser.parse_args()

    # Strip leading '--' from REMAINDER if present (argparse convention)
    forwarded: List[str] = raw_args.args
    if forwarded and forwarded[0] == "--":
        forwarded = forwarded[1:]

    script_path = Path(raw_args.script).resolve()

    if not script_path.exists():
        print(f"Error: file not found: {script_path}", file=sys.stderr)
        sys.exit(2)

    _no_integration_run(
        file=script_path,
        argv=forwarded,
        debug=raw_args.debug,
        no_warn=raw_args.no_warn,
    )


def main() -> None:
    """Top-level entry point."""
    try:
        _main_entry()
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()

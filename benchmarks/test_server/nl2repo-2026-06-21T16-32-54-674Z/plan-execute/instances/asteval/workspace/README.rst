asteval: A Safe Expression Evaluator for Python
================================================

asteval is a safe expression evaluator Python library designed to parse and
execute Python expressions in a restricted and secure manner. It is based on
Python's AST (Abstract Syntax Tree) module, which converts user-input
expressions into ASTs and evaluates them in a custom symbol table and a
controlled environment, avoiding the security risks associated with direct
use of ``eval`` or ``exec``.

Features
--------

- Safe expression evaluation using Python's AST module
- Support for arithmetic, logical, and comparison operations
- Variable assignment and symbol table management
- List, dictionary, set, and tuple operations
- Function definition and call with variable arguments
- Control flow: if, for, while, try/except, break, continue
- NumPy integration for scientific computing
- Read-only symbol protection
- Error handling and exception capture
- Configurable node processors

Installation
------------

::

    pip install asteval

Usage
-----

.. code-block:: python

    from asteval import Interpreter

    interp = Interpreter()
    result = interp("2 + 3 * 4")
    print(result)  # 14

License
-------

BSD 3-Clause License. See LICENSE for details.

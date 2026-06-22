autopep8
========

|version| |build| |codecov| |license|

autopep8 is a tool that automatically formats Python code to conform to the `PEP 8 <https://www.python.org/dev/peps/pep-0008/>`_ style guide. It uses pycodestyle to determine which parts of the code need formatting.

Installation
============

::

    pip install autopep8

Usage
=====

Format a file in-place:

::

    autopep8 --in-place example.py

Show the diff:

::

    autopep8 --diff example.py

Format from stdin:

::

    cat example.py | autopep8

Recursive formatting:

::

    autopep8 --in-place --recursive .

Using as a module:

::

    import autopep8

    code = autopep8.fix_code("x=1+2")
    print(code)  # x = 1 + 2

Options
=======

.. options_start

Use ``autopep8 --help`` for full usage.

Supported Fixes
===============

.. fixes_start

autopep8 can fix the following error codes.

License
=======

autopep8 is licensed under the MIT License. See LICENSE for details.

Contributing to autopep8
========================

We welcome contributions to autopep8! Here are some guidelines:

Reporting Issues
----------------
- Use the GitHub issue tracker
- Include the Python version and autopep8 version
- Include a minimal reproducible example
- Describe the expected vs actual behavior

Pull Requests
-------------
1. Fork the repository
2. Create a feature branch
3. Write tests for new functionality
4. Ensure all tests pass: ``pytest``
5. Format your code with autopep8 itself
6. Submit the pull request

Coding Standards
----------------
- Follow PEP 8 style guide
- Use 4 spaces for indentation
- Write docstrings for new functions
- Include tests for all new functionality

Development Setup
-----------------
::

    pip install -e ".[test]"
    pytest

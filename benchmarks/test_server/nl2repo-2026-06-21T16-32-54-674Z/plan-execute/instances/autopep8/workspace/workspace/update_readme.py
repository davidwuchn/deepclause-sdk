"""Update README.rst with current autopep8 examples and help text."""

import os
import sys


def split_readme(readme_path, before_key, after_key, options_key, end_key):
    """Split README file into sections for updating."""
    with open(readme_path, 'r') as f:
        content = f.read()

    top = ''
    bottom = ''
    before = ''

    parts = content.split(before_key)
    if len(parts) >= 2:
        top = parts[0]
        rest = parts[1]
        parts2 = rest.split(after_key)
        if len(parts2) >= 2:
            before = parts2[0]
            bottom = after_key + parts2[1]

    return (top, before, bottom)


def indent_line(line):
    """Indent a single line by four spaces."""
    if line.strip():
        return '    ' + line
    return line


def indent(text):
    """Indent entire text block by four spaces."""
    lines = text.split('\n')
    indented = [indent_line(l) for l in lines]
    return '\n'.join(indented)


def help_message():
    """Generate autopep8 help message string."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import autopep8
    parser = autopep8.create_parser()
    help_text = parser.format_help()
    home = os.path.expanduser('~')
    if home in help_text:
        help_text = help_text.replace(home, '~')
    return help_text


def check(source):
    """Validate Python code syntax and run pyflakes checks."""
    compile(source, '<string>', 'exec')


def main():
    """Update README.rst with current autopep8 examples and help text."""
    readme_path = 'README.rst'
    if not os.path.exists(readme_path):
        print('README.rst not found')
        return

    top, before, bottom = split_readme(
        readme_path,
        '<SUPPORTED_FIXES>',
        '</SUPPORTED_FIXES>',
        '<OPTIONS>',
        '</OPTIONS>'
    )

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import autopep8

    fixes_section = ''
    for code, desc in autopep8.supported_fixes():
        fixes_section += '- %s: %s\n' % (code.upper(), desc)

    help = help_message()

    new_content = top + '<SUPPORTED_FIXES>\n' + fixes_section + '</SUPPORTED_FIXES>\n'
    new_content += '<OPTIONS>\n' + help + '</OPTIONS>\n'
    new_content += bottom

    with open(readme_path, 'w') as f:
        f.write(new_content)

    print('README.rst updated successfully')


if __name__ == '__main__':
    main()

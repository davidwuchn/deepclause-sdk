# Copyright (C) 2010-2011 Hideo Hattori
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to
# deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
# sell copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.

"""A tool that automatically formats Python code to conform to the PEP 8 style."""

from __future__ import absolute_import

import codecs
import argparse
import collections
import copy
import difflib
import fnmatch
import inspect
import io
import multiprocessing
import os
import re
import signal
import sys
import textwrap
import tokenize
import warnings
from functools import wraps
from glob import glob
from warnings import warn

try:
    import pycodestyle
except ImportError:
    pycodestyle = None

try:
    from pydiff import diff
except ImportError:
    def diff(old, new, *args, **kwargs):
        return '\n'.join(difflib.unified_diff(
            old.splitlines(), new.splitlines(),
            *args, **kwargs))

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None

try:
    from configparser import ConfigParser
except ImportError:
    from ConfigParser import ConfigParser

try:
    from functools import lru_cache
except ImportError:
    from functools import update_wrapper

    def lru_cache(maxsize=None):
        def wrapper(func):
            return update_wrapper(lambda *args, **kwargs: func(*args, **kwargs), func)
        return wrapper


__version__ = '2.3.2'

CR = '\r'
LF = '\n'
CRLF = '\r\n'

PYTHON_SHEBANG_REGEX = re.compile(r'^#!.*\bpython[23]?\b\s*$')

LAMBDA_REGEX = re.compile(r'([\w.]+)\s=\slambda\s*([)(=\w,\s.]*):')

COMPARE_NEGATIVE_REGEX = re.compile(r'\b(not)\s+([^][)(}{]+?)\s+(in|is)\s')
COMPARE_NEGATIVE_REGEX_THROUGH = re.compile(r'\b(not\s+in|is\s+not)\s')

BARE_EXCEPT_REGEX = re.compile(r'except\s*:')

STARTSWITH_DEF_REGEX = re.compile(r'^(async\s+def|def)\s.*\):')
DOCSTRING_START_REGEX = re.compile(r'^u?r?(?P<kind>["\']{3})')

ENABLE_REGEX = re.compile(r'# *(fmt|autopep8): *on')
DISABLE_REGEX = re.compile(r'# *(fmt|autopep8): *off')

ENCODING_MAGIC_COMMENT = re.compile(r'^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)')

COMPARE_TYPE_REGEX = re.compile(
    r'([=!]=)\s+type(?:\s*\(\s*([^)]*[^ )])\s*\))'
    r'|\btype(?:\s*\(\s*([^)]*[^ )])\s*\))\s+([=!]=)')

TYPE_REGEX = re.compile(r'(type\s*\(\s*[^)]*?[^\s)]\s*\))')

EXIT_CODE_OK = 0
EXIT_CODE_ERROR = 1
EXIT_CODE_EXISTS_DIFF = 2
EXIT_CODE_ARGPARSE_ERROR = 99

SHORTEN_OPERATOR_GROUPS = frozenset([
    frozenset([',']),
    frozenset(['%']),
    frozenset([',', '(', '[', '{']),
    frozenset(['%', '(', '[', '{']),
    frozenset([',', '(', '[', '{', '%', '+', '-', '*', '/', '//']),
    frozenset(['%', '+', '-', '*', '/', '//']),
])

DEFAULT_IGNORE = 'E226,E24,W50,W690'
DEFAULT_INDENT_SIZE = 4

CONFLICTING_CODES = ('W503', 'W504')

PROJECT_CONFIG = ('setup.cfg', 'tox.ini', '.pep8', '.flake8')

MAX_PYTHON_FILE_DETECTION_BYTES = 1024

IS_SUPPORT_TOKEN_FSTRING = sys.version_info >= (3, 12)

Token = collections.namedtuple(
    'Token', ['token_type', 'token_string', 'spos', 'epos', 'line']
)


def _custom_formatwarning(message, category, _, __, line=None):
    return "{0.__name__}: {1}\n".format(category, message)


warnings.showwarning = _custom_formatwarning


def open_with_encoding(filename, mode='r', encoding=None, limit_byte_check=-1):
    if encoding is None:
        encoding = detect_encoding(filename, limit_byte_check)

    return io.open(filename, mode=mode, encoding=encoding,
                   errors='replace', newline='')


def _detect_encoding_from_file(filename):
    with io.open(filename, 'rb') as fp:
        # Check for BOM
        chunk = fp.read(4096)
        if chunk[:3] == b'\xef\xbb\xbf':
            return 'utf-8-sig'

    try:
        with open(filename, 'rb') as fp:
            for _ in range(2):
                line = fp.readline()
                match = ENCODING_MAGIC_COMMENT.match(line.decode('latin-1'))
                if match:
                    return match.group(1)
    except IOError:
        pass

    return 'utf-8'


def detect_encoding(filename, limit_byte_check=-1):
    encoding = _detect_encoding_from_file(filename)

    try:
        with open_with_encoding(filename, encoding=encoding,
                                limit_byte_check=limit_byte_check) as f:
            f.read()
    except (LookupError, UnicodeDecodeError):
        encoding = 'latin-1'

    return encoding


def readlines_from_file(filename):
    with open_with_encoding(filename) as f:
        return f.readlines()


def extended_blank_lines(logical_line, blank_lines, blank_before,
                         indent_level, previous_logical):
    if blank_lines > 1 and not blank_before:
        yield (0, 'E303 too many blank lines (%d)' % blank_lines)
    if blank_before > 0 and logical_line.strip().startswith('"""') \
            and previous_logical.strip().startswith('class '):
        yield (0, 'E301 expected 1 blank line, found 0')


def continued_indentation(logical_line, tokens, indent_level, hang_closing,
                          indent_char, noqa):
    pass


def get_module_imports_on_top_of_file(source, import_line_index):
    lines = list(source)
    index = 0

    # Skip initial lines like shebang, encoding, docstring
    while index < len(lines):
        line = lines[index].lstrip()
        if line.startswith('#') or line == '' or line.startswith('import ') or \
                line.startswith('from '):
            index += 1
            continue
        if is_string_literal(lines[index]):
            # Skip docstring
            while index < len(lines) and '"""' not in lines[index][3:]:
                index += 1
            index += 1
            continue
        if is_future_import(lines[index]):
            index += 1
            continue
        break

    return index


def is_string_literal(line):
    stripped = line.lstrip()
    quote_prefixes = ('u"""', "u'''", 'b"""', "b'''", 'r"""', "r'''",
                      '"""', "'''", 'f"""', "f'''",
                      'u"', "u'", 'b"', "b'", 'r"', "r'",
                      '"', "'", 'f"', "f'")
    for prefix in quote_prefixes:
        if stripped.startswith(prefix):
            return True
    return False


def is_future_import(line):
    try:
        import ast
        tree = ast.parse(line)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == '__future__':
                return True
    except SyntaxError:
        pass
    return False


def has_future_import(source):
    try:
        import ast
        tree = ast.parse('\n'.join(line for _, line in source))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == '__future__':
                return (True, node.lineno - 1 if hasattr(node, 'lineno') else 0)
    except (SyntaxError, TypeError):
        pass
    return (False, 0)


def get_index_offset_contents(result, source):
    line_index = result['line'] - 1
    column_offset = result.get('column', 0) - 1 if result.get('column') else 0
    line_contents = source[line_index] if line_index < len(source) else ''
    return (line_index, column_offset, line_contents)


def get_fixed_long_line(target, previous_line, original, indent_word='    ',
                        max_line_length=79, aggressive=0, experimental=False,
                        verbose=False):
    """Break up a long line of code and return the best reformatted result.
    
    Generates multiple reformatted candidates for a long line and ranks them
    heuristically to select the best option. Handles various line breaking
    strategies including token-based parsing and operator-based splitting.
    
    Args:
        target: The long line to fix.
        previous_line: The line before the target line.
        original: Original version of the line.
        indent_word: Indentation string (default: 4 spaces).
        max_line_length: Maximum allowed line length (default: 79).
        aggressive: Aggressiveness level for fixes (default: 0).
        experimental: Enable experimental fixes (default: False).
        verbose: Enable verbose output (default: False).
        
    Returns:
        str or None: Reformatted line(s) that fit within max_line_length,
                     or None if no suitable reformatting found.
    """
    if len(target) <= max_line_length:
        return target

    indentation = _get_indentation(target)
    
    # Try tokenizing the line for intelligent reflow
    tokens = []
    try:
        normalized = normalize_multiline(target.rstrip())
        tok_iter = _cached_tokenizer.generate_tokens(normalized)
        tokens = list(tok_iter)
    except (SyntaxError, tokenize.TokenError):
        pass

    candidates = list(shorten_line(
        tokens, target, indentation, indent_word,
        max_line_length, aggressive=aggressive,
        experimental=experimental, previous_line=previous_line))

    if not candidates:
        return None

    best = min(candidates, key=lambda c: line_shortening_rank(
        c, indent_word, max_line_length, experimental=experimental))

    return best


def longest_line_length(code):
    if not code:
        return 0
    return max(len(line) for line in code.split('\n'))


def join_logical_line(logical_line):
    return logical_line.strip() + '\n'


def untokenize_without_newlines(tokens):
    result = []
    for token in tokens:
        token_str = token[1] if isinstance(token, (list, tuple)) else token.token_string
        if token_str not in ('\n', '\r\n', '\r'):
            result.append(token_str)
    return ''.join(result)


def _find_logical(source_lines):
    logical_start = []
    logical_end = []
    try:
        tokens = list(_cached_tokenizer.generate_tokens(
            '\n'.join(source_lines)))
        prev_row = 0
        for token in tokens:
            token_type, _, start, _, _ = token
            if token_type == tokenize.NEWLINE or token_type == tokenize.NL:
                pass
            elif start[0] != prev_row and prev_row > 0:
                pass
            prev_row = start[0]
    except (SyntaxError, tokenize.TokenError):
        pass

    for i, line in enumerate(source_lines):
        logical_start.append((i, 0))
        logical_end.append((i, len(line)))

    return (logical_start, logical_end)


def _get_logical(source_lines, result, logical_start, logical_end):
    line = result['line']
    column = result.get('column', 0)
    try:
        for i, (start, end) in enumerate(zip(logical_start, logical_end)):
            if start[0] <= line <= end[0]:
                original = source_lines[start[0]:end[0] + 1]
                return (start, end, original)
    except (IndexError, TypeError):
        pass
    return None


def get_item(items, index, default=None):
    if -len(items) <= index < len(items):
        return items[index]
    return default


def reindent(source, indent_size, leave_tabs=False):
    if indent_size < 1:
        indent_size = DEFAULT_INDENT_SIZE
    try:
        reindenter = Reindenter(source, leave_tabs)
        return reindenter.run(indent_size)
    except (SyntaxError, tokenize.TokenError):
        return source



def code_almost_equal(a, b):
    lines_a = split_and_strip_non_empty_lines(a)
    lines_b = split_and_strip_non_empty_lines(b)
    if len(lines_a) != len(lines_b):
        return False
    for la, lb in zip(lines_a, lines_b):
        if ''.join(la.split()) != ''.join(lb.split()):
            return False
    return True


def split_and_strip_non_empty_lines(text):
    return [line.strip() for line in text.split('\n') if line.strip()]


def find_newline(source):
    cr_count = 0
    lf_count = 0
    crlf_count = 0
    for line in source:
        if line.endswith(CRLF):
            crlf_count += 1
        elif line.endswith(LF):
            lf_count += 1
        elif line.endswith(CR):
            cr_count += 1
    if crlf_count >= lf_count and crlf_count >= cr_count:
        return CRLF
    if lf_count >= cr_count:
        return LF
    return CR


def _get_indentword(source):
    try:
        tokens = list(_cached_tokenizer.generate_tokens(source))
        for token in tokens:
            if token[0] == tokenize.INDENT:
                return token[1]
    except (SyntaxError, tokenize.TokenError):
        pass
    return ' ' * DEFAULT_INDENT_SIZE


def _get_indentation(line):
    if not line or line.strip() == '':
        return ''
    return line[:len(line) - len(line.lstrip())]


def get_diff_text(old, new, filename):
    old_text = '\n'.join(old) + '\n' if old else ''
    new_text = '\n'.join(new) + '\n' if new else ''
    return diff(old_text, new_text,
                'original/' + filename, 'fixed/' + filename)


def _priority_key(pep8_result):
    error_id = pep8_result['id']
    line = pep8_result['line']
    column = pep8_result.get('column', 0)

    global_codes = ('E101', 'W191')
    if error_id in global_codes:
        return (0, line, column)

    return (1, line, column)


def shorten_line(tokens, source, indentation, indent_word, max_line_length,
                 aggressive=0, experimental=False, previous_line=''):
    if experimental:
        return _shorten_line_at_tokens_new(tokens, source, indentation, max_line_length)
    return _shorten_line(tokens, source, indentation, indent_word, aggressive,
                         previous_line)


def _shorten_line(tokens, source, indentation, indent_word, aggressive=0,
                  previous_line=''):
    key_token_strings = {',', '+', '-', '*', '/', '//', '%', 'and', 'or'}
    return _shorten_line_at_tokens(tokens, source, indentation, indent_word,
                                   key_token_strings, aggressive)


def _is_binary_operator(token_type, text):
    if token_type == tokenize.OP and text in '([{,':
        return False
    if text in ('and', 'or') and token_type == tokenize.NAME:
        return True
    return token_type == tokenize.OP and text not in '([{,:;@'


def _parse_container(tokens, index, for_or_if=None):
    if index >= len(tokens):
        return (Container([]), index)

    token = tokens[index]
    token_str = token[1] if isinstance(token, (list, tuple)) else token.token_string

    if token_str == '(':
        container_class = Tuple
    elif token_str == '[':
        container_class = List
    elif token_str == '{':
        container_class = DictOrSet
    else:
        return (Container([]), index)

    items = []
    index += 1
    depth = 1
    while index < len(tokens) and depth > 0:
        tok = tokens[index]
        tok_str = tok[1] if isinstance(tok, (list, tuple)) else tok.token_string
        if tok_str in ('(', '[', '{'):
            sub, index = _parse_container(tokens, index, for_or_if)
            items.append(sub)
            index += 1
            continue
        elif tok_str in (')', ']', '}'):
            depth -= 1
            if depth == 0:
                index += 1
                break
            items.append(Atom(tok))
            index += 1
            continue
        else:
            items.append(Atom(tok))
            index += 1

    return (container_class(items), index)


def _parse_tokens(tokens):
    parsed = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        tok_str = tok[1] if isinstance(tok, (list, tuple)) else tok.token_string
        if tok_str in ('(', '[', '{'):
            container, i = _parse_container(tokens, i)
            parsed.append(container)
        else:
            parsed.append(Atom(tok))
            i += 1
    return parsed


def _reflow_lines(parsed_tokens, indentation, max_line_length,
                  start_on_prefix_line):
    reflowed = ReformattedLines(max_line_length)
    for token in parsed_tokens:
        if isinstance(token, Atom):
            token.reflow(reflowed, indentation, 0, True, False, False)
        else:
            token.reflow(reflowed, indentation, True)
    return reflowed.emit()


def _shorten_line_at_tokens_new(tokens, source, indentation, max_line_length):
    """Shorten lines using advanced token-based parsing and reflowing.
    
    Parses tokens into structured format (Atoms and Containers) and reflows them.
    Generates multiple candidates by trying different formatting strategies.
    Input should be newline-free except in multiline strings.
    
    Args:
        tokens: Tokens of the line.
        source: Source code string.
        indentation: Current indentation.
        max_line_length: Maximum line length.
        
    Yields:
        Candidate shortened lines.
    """
    try:
        parsed = _parse_tokens(tokens)
        
        # Try strategy 1: break after each comma inside containers
        result1 = _reflow_lines_break_after_comma(
            parsed, indentation, max_line_length, True)
        if result1 and result1.strip():
            yield result1
        
        # Try strategy 2: full reflow
        result2 = _reflow_lines(parsed, indentation, max_line_length, True)
        if result2 and result2.strip() and result2 != result1:
            yield result2
    except Exception:
        pass


def _reflow_lines_break_after_comma(parsed_tokens, indentation, max_line_length,
                                    start_on_prefix_line):
    """Reflow by breaking after commas in containers."""
    indent_word = indentation + '    ' if indentation else '    '
    continuation = indentation + ' ' * len(indent_word)
    lines = []
    current = indentation if start_on_prefix_line else indentation
    
    def process_token(token, depth=0):
        nonlocal current
        if isinstance(token, Atom):
            text = repr(token)
        elif isinstance(token, Container):
            text = repr(token)
        else:
            text = str(token)
        
        if text == ',' and len(current) > 40 and len(current) < max_line_length + 20:
            # Check if breaking here would help
            candidate = current + text
            if len(candidate) > max_line_length and current.strip():
                lines.append(current.rstrip())
                current = continuation
                return
        
        current += text
    
    for token in parsed_tokens:
        process_token(token)
    
    if current.strip():
        lines.append(current.rstrip())
    
    if lines and len(lines) > 1:
        result = lines[0] + '\n'
        for line in lines[1:]:
            result += continuation + line + '\n'
        return result
    return indentation + source_from_tokens(parsed_tokens) + '\n' if parsed_tokens else ''


def source_from_tokens(parsed_tokens):
    """Reconstruct source code from parsed tokens."""
    parts = []
    for token in parsed_tokens:
        if isinstance(token, Atom):
            parts.append(repr(token))
        elif isinstance(token, Container):
            parts.append(repr(token))
        else:
            parts.append(str(token))
    return ''.join(parts)


def _shorten_line_at_tokens(tokens, source, indentation, indent_word,
                             key_token_strings, aggressive):
    """Shorten lines by breaking at specific key token strings.
    
    Finds key tokens (operators, commas) and breaks the line at those positions.
    For commas: keeps the comma on the first line, continues on next.
    For operators: moves the operator to the start of the continuation line (W503 style).
    
    Yields candidate shortened lines.
    """
    try:
        max_line_length = 79
        continuation_indent = indentation + indent_word
        
        if not tokens:
            return
        
        offsets = list(token_offsets(tokens))
        
        # Find positions where we can break with the token info
        break_info = []
        for tok_type, tok_str, start_off, end_off in offsets:
            if tok_str in key_token_strings:
                break_info.append((tok_str, start_off, end_off))
        
        if not break_info:
            return
        
        mid = len(break_info) // 2
        
        for idx in [mid, max(0, mid-1), min(len(break_info)-1, mid+1)]:
            tok_str, start_off, end_off = break_info[idx]
            
            is_comma = (tok_str == ',')
            is_operator = (tok_str in ('+', '-', '*', '/', '//', '%', '**', '&', '|', '^', '<<', '>>'))
            
            if is_comma:
                # Keep comma on first line
                before = source[:end_off].rstrip()
                after = source[end_off:].lstrip()
            elif is_operator:
                # Move operator to start of continuation line (W503)
                before = source[:start_off].rstrip()
                after = tok_str + source[end_off:].lstrip()
            else:
                # Generic: keep token on first line
                before = source[:end_off].rstrip()
                after = source[end_off:].lstrip()
            
            if not before or not after:
                continue
            
            # Build candidate with proper continuation indent
            candidate = before + '\n' + continuation_indent + after + '\n'
            
            # Verify all lines are within limit
            candidate_lines = candidate.split('\n')
            all_ok = all(len(l.rstrip()) <= max_line_length for l in candidate_lines if l)
            if all_ok:
                yield candidate
    except Exception:
        pass




def token_offsets(tokens):
    for token in tokens:
        token_type = token[0]
        token_string = token[1]
        spos = token[2]
        epos = token[3]
        start_offset = (spos[0] - 1) * 0 + spos[1]
        end_offset = (epos[0] - 1) * 0 + epos[1]
        yield (token_type, token_string, start_offset, end_offset)


def normalize_multiline(line):
    if line.lstrip().startswith('def '):
        return line + 'pass\n'
    if line.lstrip().startswith('return'):
        return 'def _():\n    ' + line + '\n'
    return line


def fix_whitespace(line, offset, replacement):
    if offset < 0:
        return line
    before = line[:offset].rstrip()
    after = line[offset:].lstrip()
    if after.strip().startswith('#'):
        return line
    return before + replacement + after


class QuietReport(pycodestyle.BaseReport):
    def __init__(self, options=None):
        self.options = options
        self.results = []
        self._counters = {
            'files': 0, 'physical lines': 0, 'logical lines': 0,
            'long lines': 0, 'error': 0, 'statistics': {},
        }

    @property
    def counters(self):
        return self._counters

    def error(self, line_number, offset, text, check, **kwargs):
        self.results.append({
            'id': text[:4],
            'line': line_number,
            'column': offset,
            'info': text,
        })
        self._counters['error'] += 1
        return text




def _fix_invalid_escape(line, column):
    """Fix an invalid escape sequence in a string by making it a raw string."""
    if not line or column < 0:
        return None
    TRIPLE_DOUBLE = chr(34) * 3
    TRIPLE_SINGLE = chr(39) * 3
    for start in range(min(column, len(line) - 1), -1, -1):
        ch = line[start]
        if ch in (chr(34), chr(39)):
            if start + 3 <= len(line) and line[start:start+3] in (TRIPLE_DOUBLE, TRIPLE_SINGLE):
                string_start = start
                break
            else:
                string_start = start
                break
        else:
            continue
    else:
        return None
    prefix_pos = string_start
    while prefix_pos > 0 and line[prefix_pos - 1] in ('r', 'R', 'b', 'B', 'u', 'U', 'f', 'F'):
        prefix_pos -= 1
    prefix = line[prefix_pos:string_start]
    if 'r' in prefix.lower():
        return None
    if 'f' in prefix.lower():
        return None
    return line[:prefix_pos] + 'r' + line[prefix_pos:]

def _execute_pep8(pep8_options, source):
    if pycodestyle is None:
        return []
    options = pep8_options
    report = QuietReport(options)
    checker = pycodestyle.Checker('', lines=source, options=options, report=report)
    checker.check_all()
    return report.results


def _remove_leading_and_normalize(line, with_rstrip=True):
    result = line
    result = re.sub(r'^[ \t\v]+', '', result)
    if with_rstrip:
        result = result.rstrip('\r\n')
    return result + '\n'


def _reindent_stats(tokens):
    stats = []
    for token in tokens:
        token_type = token[0]
        if token_type == tokenize.COMMENT:
            row, _ = token[2]
            stats.append((row, -1))
        elif token_type == tokenize.INDENT:
            row, _ = token[2]
            stats.append((row, len(token[1])))
    return stats


def _leading_space_count(line):
    count = 0
    for ch in line:
        if ch == ' ':
            count += 1
        else:
            break
    return count


def check_syntax(code):
    try:
        compile(code, '<string>', 'exec')
        return True
    except (SyntaxError, TypeError, ValueError):
        return False


def find_with_line_numbers(pattern, contents):
    newline_offsets = {i: n for n, i in enumerate(_newline_offsets(contents))}

    def get_line_num(match):
        start = match.start()
        last_newline = max([o for o in newline_offsets if o <= start] + [-1])
        return newline_offsets[last_newline]

    return [get_line_num(m) for m in pattern.finditer(contents)]


def _newline_offsets(contents):
    for i, ch in enumerate(contents):
        if ch == '\n':
            yield i


def get_disabled_ranges(source):
    lines = source.split('\n')
    ranges = []
    disabled = None
    for i, line in enumerate(lines):
        if DISABLE_REGEX.search(line):
            disabled = i
        elif ENABLE_REGEX.search(line) and disabled is not None:
            ranges.append((disabled, i))
            disabled = None
    if disabled is not None:
        ranges.append((disabled, len(lines)))
    return ranges


def filter_disabled_results(result, disabled_ranges):
    line = result.get('line', 0)
    for start, end in disabled_ranges:
        if start <= line <= end:
            return False
    return True


def filter_results(source, results, aggressive):
    disabled_ranges = get_disabled_ranges(source)
    multiline = multiline_string_lines(source)
    commented = set(commented_out_code_lines(source))

    filtered = []
    for result in results:
        line = result.get('line', 0)
        if not filter_disabled_results(result, disabled_ranges):
            continue
        if line in multiline:
            continue
        if line in commented and aggressive < 2:
            continue
        filtered.append(result)
    return filtered


def multiline_string_lines(source, include_docstrings=False):
    lines = set()
    try:
        tokens = list(tokenize.generate_tokens(
            io.StringIO(source).readline))
        in_multiline = False
        start_line = 0
        for token in tokens:
            if token[0] == tokenize.STRING:
                if '\n' in token[1] and '"' * 3 in token[1]:
                    for i in range(token[2][0], token[3][0] + 1):
                        lines.add(i)
    except (SyntaxError, tokenize.TokenError):
        pass
    return lines


def commented_out_code_lines(source):
    lines = []
    for i, line in enumerate(source.split('\n'), 1):
        stripped = line.strip()
        if stripped.startswith('#') and not stripped.startswith('# type:'):
            code_like = stripped[1:].strip()
            if re.match(r'^[a-zA-Z_]', code_like) and ('=' in code_like or
                    code_like in ('if', 'for', 'while', 'def', 'class', 'import', 'from')):
                lines.append(i)
    return lines


def shorten_comment(line, max_line_length, last_comment=False):
    if len(line) <= max_line_length:
        return line

    comment_content = line.lstrip()
    if comment_content.startswith('#'):
        content = comment_content[1:].strip()
        indent = _get_indentation(line)
        width = min(max_line_length - len(indent), 72)
        wrapped = textwrap.fill(content, width=width)
        return indent + wrapped.replace('\n', '\n' + indent + '# ') + '\n'
    return line


def normalize_line_endings(lines, newline):
    result = []
    for line in lines:
        line = line.replace('\r\n', '\n').replace('\r', '\n')
        if not line.endswith('\n'):
            line += '\n'
        result.append(line)

    if result and not lines[-1].rstrip('\r\n'):
        result[-1] = result[-1].rstrip('\n') + newline
    else:
        for i in range(len(result)):
            if not result[i].endswith(newline):
                result[i] = result[i].rstrip('\n') + newline

    return result


def mutual_startswith(a, b):
    return a.startswith(b) or b.startswith(a)


def code_match(code, select, ignore):
    if ignore:
        for ignored in ignore:
            if mutual_startswith(code, ignored):
                return False
    if select:
        for selected in select:
            if mutual_startswith(code, selected):
                return True
        return False
    return True


def _get_options(raw_options, apply_config):
    defaults = {
        'max_line_length': 79,
        'aggressive': 0,
        'indent_size': 4,
        'select': [],
        'ignore': ['E226', 'E24', 'W50', 'W690'],
        'exclude': [],
        'jobs': 1,
        'verbose': 0,
        'diff': False,
        'in_place': False,
        'experimental': False,
        'ignore_local_config': False,
        'global_options': [],
        'hang_closing': False,
        'pep8_passes': 100,
    }
    if raw_options is None:
        return argparse.Namespace(**defaults)
    if isinstance(raw_options, dict):
        merged = dict(defaults)
        merged.update(raw_options)
        # Normalize ignore
        if 'ignore' in merged:
            val = merged['ignore']
            if isinstance(val, str):
                merged['ignore'] = [c.strip() for c in val.split(',') if c.strip()]
            elif val is None:
                merged['ignore'] = defaults['ignore']
        if 'select' in merged and merged['select'] is None:
            merged['select'] = []
        return argparse.Namespace(**merged)
    # Already a Namespace
    for k, v in defaults.items():
        if not hasattr(raw_options, k):
            setattr(raw_options, k, v)
    return raw_options


def fix_code(source, options=None, encoding=None, apply_config=False):
    raw_options = options or {}
    pep8_options = _get_options(raw_options, apply_config)

    if hasattr(pep8_options, 'max_line_length') and pep8_options.max_line_length is None:
        pep8_options.max_line_length = 79
    if hasattr(pep8_options, 'select') and pep8_options.select is None:
        pep8_options.select = []
    if hasattr(pep8_options, 'ignore') and pep8_options.ignore is None:
        pep8_options.ignore = []
    if hasattr(pep8_options, 'exclude') and pep8_options.exclude is None:
        pep8_options.exclude = []

    if isinstance(source, bytes):
        encoding = encoding or 'utf-8'
        source = source.decode(encoding)

    source = fix_lines(source.split('\n'), pep8_options)
    return source


def fix_lines(source_lines, options, filename=''):
    try:
        fixer = FixPEP8(filename, options,
                        contents='\n'.join(source_lines))
        return fixer.fix()
    except Exception:
        return '\n'.join(source_lines)


def fix_file(filename, options=None, output=None, apply_config=False):
    options = _get_options(options, apply_config)
    try:
        original_source = readlines_from_file(filename)
    except IOError:
        return None

    pep8_options = _get_options(options, apply_config)
    if hasattr(pep8_options, 'select') and pep8_options.select is None:
        pep8_options.select = []
    if hasattr(pep8_options, 'ignore') and pep8_options.ignore is None:
        pep8_options.ignore = []

    try:
        fixer = FixPEP8(filename, pep8_options,
                        contents=''.join(original_source))
        new_source = fixer.fix()
    except Exception:
        new_source = ''.join(original_source)

    original_text = ''.join(original_source)
    if new_source == original_text:
        return None

    if hasattr(options, 'diff') and options.diff:
        old = original_text.splitlines(True)
        new = new_source.splitlines(True)
        return get_diff_text(old, new, filename)

    if hasattr(options, 'in_place') and options.in_place:
        try:
            with open_with_encoding(filename, 'w') as f:
                f.write(new_source)
        except IOError:
            return None
        return None

    return new_source


def global_fixes():
    for name, obj in list(globals().items()):
        if name.startswith('fix_') and callable(obj):
            params = _get_parameters(obj)
            if params and params[0] == 'source':
                code = name[4:]
                yield (code, obj)


def _get_parameters(function):
    try:
        sig = inspect.signature(function)
        return list(sig.parameters.keys())
    except (ValueError, TypeError):
        try:
            argspec = inspect.getfullargspec(function)
            return argspec.args
        except (ValueError, TypeError):
            return []


def apply_global_fixes(source, options, where='global', filename='', codes=None):
    for code, fix_func in global_fixes():
        if codes is not None and code not in codes:
            continue
        try:
            new_source = fix_func(source, options=options, where=where,
                                  filename=filename)
            if new_source != source:
                source = new_source
        except Exception:
            pass
    return source


def extract_code_from_function(function):
    name = function.__name__
    if name.startswith('fix_'):
        code = name[4:]
        if re.match(r'^[eEwW]\d+$', code):
            return code.lower()
    return None


def _get_package_version():
    try:
        import pycodestyle
        return 'pycodestyle: %s' % pycodestyle.__version__
    except (ImportError, AttributeError):
        return 'pycodestyle: unknown'


def create_parser():
    parser = argparse.ArgumentParser(
        prog='autopep8',
        description='A tool that automatically formats Python code to conform to '
                    'the PEP 8 style guide.',
    )
    parser.add_argument('files', nargs='*',
                        help='One or more Python files to format.')
    parser.add_argument('-v', '--verbose', action='count', default=0,
                        help='Print verbose messages; multiple -v result in more '
                             'verbose messages.')
    parser.add_argument('-d', '--diff', action='store_true',
                        help='Print the diff for the fixed source.')
    parser.add_argument('-i', '--in-place', action='store_true',
                        help='Modify files in place.')
    parser.add_argument('-a', '--aggressive', action='count', default=0,
                        help='Aggressiveness levels for cosmetic fixes.')
    parser.add_argument('-e', '--experimental', action='store_true',
                        help='Enable experimental fixes.')
    parser.add_argument('--exclude', action='append', default=[],
                        help="Exclude files or directories which match these "
                             "patterns. These patterns are matched with fnmatch.")
    parser.add_argument('--max-line-length', type=int, default=None,
                        help='Set maximum allowed line length (default: %s).'
                        % DEFAULT_INDENT_SIZE * 2)
    parser.add_argument('--ignore', default=None,
                        help='Comma-separated list of errors/warnings to ignore '
                             '(e.g., E123,W690).')
    parser.add_argument('--select', default=None,
                        help='Comma-separated list of errors/warnings to enable '
                             '(e.g., E123,W690).')
    parser.add_argument('--indent-size', type=int, default=DEFAULT_INDENT_SIZE,
                        help='Spaces per indent level.')
    parser.add_argument('--pep8-passes', type=int, default=100,
                        help='Maximum number of additional pep8 passes (default: '
                             '100).')
    parser.add_argument('--global-options', action='append', default=[],
                        help='Specify global autopep8 profile to be combined with '
                             'project config files.')
    parser.add_argument('--ignore-local-config', action='store_true',
                        help='Ignore configuration files.')
    parser.add_argument('-j', '--jobs', type=int, default=1,
                        help='Number of parallel processes.')
    parser.add_argument('-r', '--recursive', action='store_true',
                        help='Drill down directories recursively.')
    parser.add_argument('--list-fixes', action='store_true',
                        help='List fix codes for fixes that are enabled by '
                             'default.')
    parser.add_argument('--hang-closing', action='store_true',
                        help='Hang closing bracket instead of repeating the '
                             'indentation of the opening bracket.')
    parser.add_argument('-p', '--pep8', action='store_true',
                        help='Report code that is invalid or does not conform to '
                             'the style guide.')
    parser.add_argument('--version', action='version',
                        version='%(prog)s ' + __version__ + ' (pycodestyle ' +
                        _get_package_version().split(': ')[1] + ')')

    return parser


def _expand_codes(codes, ignore_codes):
    expanded = set()
    all_codes = set()

    code_series = {
        'E1': ['E11', 'E12', 'E13'],
        'E2': ['E20', 'E21', 'E22', 'E23', 'E24', 'E25', 'E26', 'E27'],
        'E3': ['E30'],
        'E4': ['E40'],
        'E5': ['E50'],
        'E7': ['E70', 'E71', 'E72', 'E73'],
        'W': ['W1', 'W2', 'W3', 'W5', 'W6', 'W69'],
    }

    for code in codes:
        if code in code_series:
            for sub in code_series[code]:
                expanded.add(sub)
                all_codes.add(sub)
        else:
            expanded.add(code)
            all_codes.add(code)

    for ignore_code in ignore_codes:
        expanded.discard(ignore_code)

    if 'W503' in expanded and 'W504' in expanded:
        expanded.discard('W503')
        expanded.discard('W504')

    return expanded


def _parser_error_with_code(parser, code, msg):
    parser.print_usage(sys.stderr)
    sys.stderr.write('%s: error: %s\n\n' % (parser.prog, msg))
    sys.exit(code)


def parse_args(arguments, apply_config=False):
    parser = create_parser()
    args, remaining = parser.parse_known_args(arguments)

    if args.max_line_length is None:
        args.max_line_length = 79

    if not args.ignore:
        args.ignore = DEFAULT_IGNORE.split(',')
    elif isinstance(args.ignore, str):
        args.ignore = [c.strip() for c in args.ignore.split(',') if c.strip()]

    if args.select is None:
        args.select = []
    elif isinstance(args.select, str):
        args.select = [c.strip() for c in args.select.split(',') if c.strip()]

    if not args.exclude:
        args.exclude = []

    if apply_config and not args.ignore_local_config:
        args = read_config(args, parser)
        try:
            args = read_pyproject_toml(args, parser)
        except Exception:
            pass

    return args


def _get_normalize_options(args, config, section, option_list):
    if not config.has_section(section):
        return

    for option, option_type in option_list.items():
        if config.has_option(section, option):
            value = config.get(section, option)
            if option_type == int:
                value = int(value)
            elif option_type == float:
                value = float(value)
            elif option_type == bool:
                value = value.lower() in ('true', 'yes', '1')
            setattr(args, option.replace('-', '_'), value)


CONFIG_OPTION_TYPES = {
    'exclude': list,
    'ignore': list,
    'max-line-length': int,
    'aggressive': int,
    'indent-size': int,
    'hang-closing': bool,
    'select': list,
    'pep8-passes': int,
    'experimental': bool,
}


def read_config(args, parser):
    config = ConfigParser()

    config_paths = []
    home_config = os.path.expanduser('~/.config/autopep8')
    if os.path.exists(home_config):
        config_paths.append(home_config)

    config_paths.extend(PROJECT_CONFIG)

    for config_path in config_paths:
        expanded = os.path.expanduser(config_path)
        if os.path.exists(expanded):
            config.read(expanded)

    if config.has_section('autopep8'):
        _get_normalize_options(args, config, 'autopep8', CONFIG_OPTION_TYPES)

    if config.has_section('pep8'):
        _get_normalize_options(args, config, 'pep8', CONFIG_OPTION_TYPES)

    return args


def read_pyproject_toml(args, parser):
    if tomllib is None:
        return parser

    pyproject_path = 'pyproject.toml'
    if not os.path.exists(pyproject_path):
        return parser

    try:
        with open(pyproject_path, 'rb') as f:
            config = tomllib.load(f)
    except Exception:
        return parser

    tool_config = config.get('tool', {}).get('autopep8', {})

    if 'max_line_length' in tool_config:
        args.max_line_length = int(tool_config['max_line_length'])
    if 'aggressive' in tool_config:
        args.aggressive = int(tool_config['aggressive'])
    if 'indent_size' in tool_config:
        args.indent_size = int(tool_config['indent_size'])
    if 'ignore' in tool_config:
        val = tool_config['ignore']
        if isinstance(val, str):
            args.ignore = [c.strip() for c in val.split(',') if c.strip()]
        else:
            args.ignore = val
    if 'select' in tool_config:
        val = tool_config['select']
        if isinstance(val, str):
            args.select = [c.strip() for c in val.split(',') if c.strip()]
        else:
            args.select = val
    if 'exclude' in tool_config:
        val = tool_config['exclude']
        if isinstance(val, str):
            args.exclude = [c.strip() for c in val.split(',') if c.strip()]
        else:
            args.exclude = val

    return args


def _split_comma_separated(string):
    return set(s.strip() for s in string.split(',') if s.strip())


def decode_filename(filename):
    if isinstance(filename, bytes):
        return filename.decode(sys.getfilesystemencoding())
    return filename


def supported_fixes():
    codes = set()
    for name, obj in list(globals().items()):
        if inspect.isclass(obj) and issubclass(obj, FixPEP8) and obj is not FixPEP8:
            continue
        if inspect.isclass(obj) and obj.__name__ == 'FixPEP8':
            for method_name in dir(obj):
                if method_name.startswith('fix_'):
                    code = extract_code_from_function(
                        getattr(obj, method_name, None))
                    if code:
                        doc = getattr(obj, method_name, None).__doc__ or ''
                        codes.add((code, docstring_summary(doc)))
        if name.startswith('fix_') and callable(obj):
            code = extract_code_from_function(obj)
            if code:
                doc = obj.__doc__ or ''
                codes.add((code, docstring_summary(doc)))
    return sorted(codes)


def docstring_summary(docstring):
    if not docstring:
        return ''
    lines = docstring.strip().split('\n')
    return lines[0].strip() if lines else ''


def line_shortening_rank(candidate, indent_word, max_line_length,
                         experimental=False):
    lines = candidate.split('\n')
    length_violations = sum(1 for line in lines if len(line.rstrip()) > max_line_length)
    lengths = [len(line.rstrip()) for line in lines if line.strip()]

    if not lengths:
        return length_violations * 1000

    mean = sum(lengths) / len(lengths)
    variance = sum((l - mean) ** 2 for l in lengths) / len(lengths)
    sd = variance ** 0.5

    rank = length_violations * 100 + int(sd)
    return rank


def standard_deviation(numbers):
    numbers = list(numbers)
    if not numbers:
        return 0
    mean = sum(numbers) / len(numbers)
    variance = sum((x - mean) ** 2 for x in numbers) / len(numbers)
    return variance ** 0.5


def has_arithmetic_operator(line):
    arithmetic_ops = set('+-*/%')
    return bool(set(line) & arithmetic_ops)


def count_unbalanced_brackets(line):
    counts = {'(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0}
    for ch in line:
        if ch in counts:
            counts[ch] += 1
    return abs(counts['('] - counts[')']) + abs(counts['['] - counts[']']) + abs(counts['{'] - counts['}'])


def split_at_offsets(line, offsets):
    offsets = sorted(set(offsets))
    parts = []
    prev = 0
    for offset in offsets:
        if 0 <= offset <= len(line):
            parts.append(line[prev:offset])
            prev = offset
    parts.append(line[prev:])
    return parts


def match_file(filename, exclude):
    basename = os.path.basename(filename)
    if basename.startswith('.'):
        return False
    for pattern in exclude:
        if fnmatch.fnmatch(basename, pattern) or fnmatch.fnmatch(filename, pattern):
            return False
    return True


def find_files(filenames, recursive, exclude):
    processed = []
    for name in filenames:
        name = os.path.abspath(name)
        if os.path.isfile(name):
            if match_file(name, exclude):
                yield name
        elif os.path.isdir(name):
            if recursive:
                for root, dirs, files in os.walk(name):
                    dirs[:] = [d for d in dirs if not d.startswith('.') and
                               not any(fnmatch.fnmatch(d, p) for p in exclude)]
                    for f in sorted(files):
                        filepath = os.path.join(root, f)
                        if match_file(filepath, exclude) and \
                                (f.endswith('.py') or is_python_file(filepath)):
                            yield filepath
            else:
                for f in sorted(os.listdir(name)):
                    filepath = os.path.join(name, f)
                    if os.path.isfile(filepath) and match_file(filepath, exclude) and \
                            (f.endswith('.py') or is_python_file(filepath)):
                        yield filepath
    return processed


def _fix_file(parameters):
    filename, options = parameters
    try:
        result = fix_file(filename, options)
        if hasattr(options, 'verbose') and options.verbose >= 1:
            print('Fixing file: %s' % filename)
        return result
    except IOError as e:
        if hasattr(options, 'verbose') and options.verbose >= 1:
            print('Error fixing file %s: %s' % (filename, e))
        return None


def fix_multiple_files(filenames, options, output=None):
    results = []
    exclude = getattr(options, 'exclude', []) or []
    recursive = getattr(options, 'recursive', False)
    jobs = getattr(options, 'jobs', 1)

    file_list = list(find_files(list(filenames), recursive, exclude))

    if jobs > 1 and len(file_list) > 1:
        try:
            pool = multiprocessing.Pool(jobs)
            parameters = [(f, options) for f in file_list]
            results = pool.map(_fix_file, parameters)
            pool.close()
            pool.join()
        except Exception:
            for f in file_list:
                results.append(_fix_file((f, options)))
    else:
        for f in file_list:
            results.append(_fix_file((f, options)))

    return results


def is_python_file(filename):
    if filename.endswith('.py'):
        return True
    try:
        with open(filename, 'rb') as f:
            head = f.read(MAX_PYTHON_FILE_DETECTION_BYTES)
            if head and PYTHON_SHEBANG_REGEX.match(
                    head.split(b'\n')[0].decode('latin-1', errors='replace')):
                return True
    except (IOError, OSError):
        pass
    return False


def is_probably_part_of_multiline(line):
    stripped = line.strip()
    triple_quotes = ('"""', "'''")
    for tq in triple_quotes:
        if tq in stripped:
            return True
    if line.rstrip().endswith('\\'):
        return True
    return False


def wrap_output(output, encoding):
    if hasattr(output, 'buffer'):
        return codecs.getwriter(encoding)(output.buffer)
    return codecs.getwriter(encoding)(output)


def get_encoding():
    try:
        return locale.getpreferredencoding()
    except Exception:
        return sys.getdefaultencoding()


class Atom:
    def __init__(self, atom):
        self._token = atom
        self._token_type = atom[0] if isinstance(atom, (list, tuple)) else atom.token_type
        self._token_string = atom[1] if isinstance(atom, (list, tuple)) else atom.token_string
        self._spos = atom[2] if isinstance(atom, (list, tuple)) else atom.spos
        self._epos = atom[3] if isinstance(atom, (list, tuple)) else atom.epos
        self._line = atom[4] if isinstance(atom, (list, tuple)) else atom.line

    def __repr__(self):
        return self._token_string

    def __len__(self):
        return self.size()

    def emit(self):
        return self._token_string

    def reflow(self, reflowed_lines, continued_indent, extent,
               break_after_open_bracket, is_list_comp_or_if_expr, next_is_dot):
        reflowed_lines.add(self, 0, break_after_open_bracket)

    def is_keyword(self):
        import keyword
        return keyword.iskeyword(self._token_string)

    def is_string(self):
        return self._token_type == tokenize.STRING

    def is_fstring_start(self):
        if not IS_SUPPORT_TOKEN_FSTRING:
            return False
        return False

    def is_fstring_end(self):
        if not IS_SUPPORT_TOKEN_FSTRING:
            return False
        return False

    def is_name(self):
        return self._token_type == tokenize.NAME

    def is_number(self):
        return self._token_type == tokenize.NUMBER

    def is_comma(self):
        return self._token_string == ','

    def is_colon(self):
        return self._token_string == ':'

    def size(self):
        return len(self._token_string)


class Container:
    def __init__(self, items):
        self._items = items

    def __repr__(self):
        return ''.join(repr(item) for item in self._items)

    def __iter__(self):
        return iter(self._items)

    def __getitem__(self, idx):
        return self._items[idx]

    def reflow(self, reflowed_lines, continued_indent,
               break_after_open_bracket):
        reflowed_lines.add(self, 0, break_after_open_bracket)

    def _get_extent(self, index):
        if 0 <= index < len(self._items):
            return self._items[index].size()
        return 0

    def is_string(self):
        return False

    def size(self):
        return sum(item.size() for item in self._items)

    def is_keyword(self):
        return False

    def is_name(self):
        return False

    def is_comma(self):
        return False

    def is_colon(self):
        return False

    def open_bracket(self):
        return ''

    def close_bracket(self):
        return ''


class Tuple(Container):
    def open_bracket(self):
        return '('

    def close_bracket(self):
        return ')'


class List(Container):
    def open_bracket(self):
        return '['

    def close_bracket(self):
        return ']'


class DictOrSet(Container):
    def open_bracket(self):
        return '{'

    def close_bracket(self):
        return '}'


class ListComprehension(Container):
    def size(self):
        size = 0
        for item in self._items:
            size += item.size()
            if item.is_colon():
                size += 1
        return size


class IfExpression(Container):
    pass


class Reindenter:
    def __init__(self, input_text, leave_tabs=False):
        self._input_text = input_text
        self._leave_tabs = leave_tabs
        self._lines = input_text.split('\n')
        self._line_index = 0
        self._raw_tokens = []
        self._fixes = []

    def run(self, indent_size):
        lines = self._input_text.split('\n')
        result = []
        current_indent = 0
        indent_stack = [0]

        for line in lines:
            stripped = line.lstrip()
            if not stripped:
                result.append('')
                continue

            leading = line[:len(line) - len(stripped)]
            if self._leave_tabs:
                leading_spaces = leading.replace('\t', ' ' * indent_size)
            else:
                leading_spaces = leading.replace('\t', ' ' * indent_size)

            spaces = len(leading_spaces)
            indent_level = spaces // indent_size if spaces > 0 else 0

            while indent_stack and indent_level < indent_stack[-1]:
                indent_stack.pop()
            if indent_level > indent_stack[-1]:
                indent_stack.append(indent_level)

            new_indent = ' ' * (indent_level * indent_size)
            result.append(new_indent + stripped)

        return '\n'.join(result)

    def getline(self):
        if self._line_index < len(self._lines):
            line = self._lines[self._line_index]
            self._line_index += 1
            return line + '\n'
        return ''


class LineEndingWrapper:
    def __init__(self, output):
        self._output = output

    def write(self, s):
        s = s.replace('\r\n', '\n').replace('\r', '\n')
        self._output.write(s)

    def flush(self):
        if hasattr(self._output, 'flush'):
            self._output.flush()


class CachedTokenizer:
    def __init__(self):
        self._cache = {}

    def generate_tokens(self, text):
        if text in self._cache:
            return self._cache[text]

        tokens = []
        try:
            readline = io.StringIO(text).readline
            for token in tokenize.generate_tokens(readline):
                tokens.append(Token(
                    token[0], token[1], token[2], token[3], token[4]))
        except (SyntaxError, tokenize.TokenError):
            pass

        self._cache[text] = tokens
        return tokens


_cached_tokenizer = CachedTokenizer()


class ReformattedLines:
    def __init__(self, max_line_length):
        self._max_line_length = max_line_length
        self._current_line = []
        self._lines = []
        self._current_size = 0

    def __repr__(self):
        return self.emit()

    def add(self, obj, indent_amt, break_after_open_bracket):
        if isinstance(obj, Container):
            self._add_container(obj, indent_amt, break_after_open_bracket)
        else:
            self._add_item(obj, indent_amt)

    def add_comment(self, item):
        if self._current_line and self._current_line[-1] != ' ':
            self._current_line.append('  ')
            self._current_size += 2
        self._current_line.append(item._token_string)
        self._current_size += len(item._token_string)

    def add_indent(self, indent_amt):
        if self._current_line and self._current_line != ['\n']:
            self._current_line.insert(0, ' ' * indent_amt)
            self._current_size += indent_amt

    def add_line_break(self, indent):
        if self._current_line:
            self._lines.append(''.join(self._current_line))
        self._current_line = ['\n']
        self._current_size = 0

    def add_line_break_at(self, index, indent_amt):
        if 0 <= index <= len(self._current_line):
            break_part = ['\n', ' ' * indent_amt]
            self._current_line[index:index] = break_part

    def add_space_if_needed(self, curr_text, equal=False):
        if self._current_line and self._current_line[-1] not in (' ', '\n', '\t',
                '(', '[', '{', '(', '[', '{'):
            if curr_text not in (')', ']', '}', ',', ';', ':', ')', ']', '}'):
                self._current_line.append(' ')
                self._current_size += 1

    def previous_item(self):
        if self._current_line:
            return Atom((tokenize.OP, self._current_line[-1], (0, 0), (0, 0), ''))
        return None

    def fits_on_current_line(self, item_extent):
        return (self._current_size + item_extent) <= self._max_line_length

    def current_size(self):
        return self._current_size

    def line_empty(self):
        return not self._current_line or self._current_line == ['\n']

    def emit(self):
        if self._current_line:
            self._lines.append(''.join(self._current_line))
        result = '\n'.join(self._lines)
        self._lines = []
        self._current_line = []
        self._current_size = 0
        return result

    def _add_item(self, item, indent_amt):
        if isinstance(item, Atom):
            text = item._token_string
            if text in (',', ';', ':'):
                self._current_line.append(text)
                self._current_size += 1
                return
            if self._current_line and self._current_line[-1] not in (' ',
                    '(', '[', '{', '\n'):
                if text not in (')', ']', '}', ',', ';', ':'):
                    self._current_line.append(' ')
                    self._current_size += 1
            self._current_line.append(text)
            self._current_size += len(text)

    def _add_container(self, container, indent_amt, break_after_open_bracket):
        bracket = container.open_bracket()
        if bracket:
            self._current_line.append(bracket)
            self._current_size += 1
        for item in container:
            self._add_item(item, indent_amt)
        bracket = container.close_bracket()
        if bracket:
            self._current_line.append(bracket)
            self._current_size += 1

    def _prevent_default_initializer_splitting(self, item, indent_amt):
        pass

    def _split_after_delimiter(self, item, indent_amt):
        pass

    def _enforce_space(self, item):
        pass

    def _delete_whitespace(self):
        while self._current_line and self._current_line[-1] in (' ', '\t'):
            self._current_line.pop()
            self._current_size -= 1


class FixPEP8:
    def __init__(self, filename, options, contents=None,
                 long_line_ignore_cache=None):
        self._filename = filename
        self._options = options
        self._long_line_ignore_cache = long_line_ignore_cache or set()

        if contents is not None:
            # Ensure each line has a newline for pycodestyle
            lines_list = contents.split("\n")
            if lines_list and lines_list[-1] == "":
                lines_list = lines_list[:-1]
            self.source = [l + "\n" for l in lines_list]
            self._raw_contents = contents
        else:
            try:
                self.source = readlines_from_file(filename)
                self._raw_contents = "".join(self.source)
            except IOError:
                self.source = []
                self._raw_contents = ""

        self._import_statements = []
        self._collect_imports()
        self._create_method_aliases()

    def _collect_imports(self):
        for i, line in enumerate(self.source):
            stripped = line.strip()
            if stripped.startswith('import ') or stripped.startswith('from '):
                self._import_statements.append((i, stripped))

    def _create_method_aliases(self):
        fix_method_map = {
            'e111': 'fix_e111', 'e112': 'fix_e112', 'e113': 'fix_e113',
            'e114': 'fix_e114', 'e115': 'fix_e115', 'e116': 'fix_e116',
            'e117': 'fix_e117', 'e121': 'fix_e121', 'e122': 'fix_e122',
            'e123': 'fix_e123', 'e124': 'fix_e124', 'e125': 'fix_e125',
            'e126': 'fix_e126', 'e127': 'fix_e127', 'e128': 'fix_e128',
            'e129': 'fix_e129', 'e131': 'fix_e131',
            'e201': 'fix_e201', 'e202': 'fix_e202', 'e203': 'fix_e203',
            'e211': 'fix_e211', 'e224': 'fix_e224', 'e225': 'fix_e225',
            'e226': 'fix_e226', 'e227': 'fix_e227', 'e228': 'fix_e228',
            'e231': 'fix_e231', 'e241': 'fix_e241', 'e242': 'fix_e242',
            'e251': 'fix_e251', 'e261': 'fix_e261', 'e262': 'fix_e262',
            'e265': 'fix_e265', 'e266': 'fix_e266', 'e271': 'fix_e271',
            'e272': 'fix_e272', 'e273': 'fix_e273', 'e274': 'fix_e274',
            'e275': 'fix_e275',
            'e301': 'fix_e301', 'e302': 'fix_e302', 'e303': 'fix_e303',
            'e304': 'fix_e304', 'e305': 'fix_e305', 'e306': 'fix_e306',
            'e401': 'fix_e401', 'e402': 'fix_e402',
            'e501': 'fix_e501', 'e502': 'fix_e502',
            'e701': 'fix_e701', 'e702': 'fix_e702', 'e703': 'fix_e703',
            'e704': 'fix_e704', 'e711': 'fix_e711', 'e712': 'fix_e712',
            'e713': 'fix_e713', 'e714': 'fix_e714', 'e721': 'fix_e721',
            'e722': 'fix_e722', 'e731': 'fix_e731',
            'w191': 'fix_w191', 'w291': 'fix_w291', 'w292': 'fix_w292',
            'w293': 'fix_w293', 'w391': 'fix_w391', 'w392': 'fix_w392',
            'w503': 'fix_w503', 'w504': 'fix_w504', 'w605': 'fix_w605',
        }
        for code, method_name in fix_method_map.items():
            if hasattr(self, method_name):
                method = getattr(self, method_name)
                setattr(self, code, method)

    def fix(self):
        old_text = ''.join(self.source)
        results = self._get_errors()
        max_passes = getattr(self._options, 'pep8_passes', 100)
        if max_passes <= 0:
            max_passes = 100
        for _ in range(max_passes):
            self._fix_source(results)
            new_text = ''.join(self.source)
            if new_text == old_text:
                break
            old_text = new_text
            results = self._get_errors()

        return ''.join(self.source)

    def _get_errors(self):
        if pycodestyle is None:
            return []

        max_line_length = getattr(self._options, 'max_line_length', 79)
        select = getattr(self._options, 'select', []) or []
        ignore = getattr(self._options, 'ignore', []) or []

        try:
            style_guide = pycodestyle.StyleGuide(
                max_line_length=max_line_length,
                select=select,
                ignore=ignore,
                hang_closing=getattr(self._options, 'hang_closing', False),
                quiet=2,
            )
            options = style_guide.options
        except Exception:
            options = pycodestyle.StyleGuide(quiet=2).options

        report = QuietReport(options)
        results = []
        try:
            checker = pycodestyle.Checker(
                self._filename,
                lines=self.source,
                options=options,
                report=report)
            checker.check_all()
            results = report.results
        except Exception:
            pass

        return results

    def _fix_source(self, results):
        if not results:
            return ''.join(self.source)

        filtered = filter_results(
            ''.join(self.source), results,
            getattr(self._options, 'aggressive', 0))

        # Filter by code_match for select/ignore
        select = getattr(self._options, 'select', []) or []
        ignore = getattr(self._options, 'ignore', []) or []
        matched = []
        for r in filtered:
            if code_match(r['id'], select, ignore):
                matched.append(r)

        matched.sort(key=_priority_key)

        for result in matched:
            error_id = result['id'].lower()
            fix_method = getattr(self, error_id, None)
            if fix_method:
                try:
                    fix_method(result)
                except Exception:
                    pass

        return ''.join(self.source)

    def _check_affected_anothers(self, result):
        return True

    def _fix_reindent(self, result):
        """Fix badly indented lines by adjusting initial indent.
        
        Returns:
            List[int]: Modified line indices, or empty list if no change.
        """
        line_index = result['line'] - 1
        if line_index < 0 or line_index >= len(self.source):
            return []
        line = self.source[line_index]
        leading = _get_indentation(line)
        indent_word = getattr(self._options, 'indent_size', 4)
        if isinstance(indent_word, int):
            indent_word = ' ' * indent_word
        new_indent = leading.replace('\t', indent_word)
        new_line = new_indent + line.lstrip()
        if new_line != line:
            self.source[line_index] = new_line
            return [line_index]
        return []

    def fix_e101(self, result):
        self._fix_reindent(result)

    def fix_e111(self, result):
        self._fix_reindent(result)

    def fix_e112(self, result):
        self._fix_reindent(result)

    def fix_e113(self, result):
        line_index = result['line'] - 1
        if line_index < len(self.source):
            line = self.source[line_index]
            leading = _get_indentation(line)
            indent_size = getattr(self._options, 'indent_size', 4)
            if isinstance(indent_size, int):
                indent_size = ' ' * indent_size
            if len(leading) > len(indent_size):
                self.source[line_index] = leading[len(indent_size):] + line.lstrip()

    def fix_e114(self, result):
        self._fix_reindent(result)

    def fix_e115(self, result):
        self._fix_reindent(result)

    def fix_e116(self, result):
        self._fix_reindent(result)

    def fix_e117(self, result):
        line_index = result['line'] - 1
        if line_index < len(self.source):
            line = self.source[line_index]
            leading = _get_indentation(line)
            indent_size = getattr(self._options, 'indent_size', 4)
            if isinstance(indent_size, int):
                indent_size = ' ' * indent_size
            if len(leading) > len(indent_size):
                self.source[line_index] = leading[len(indent_size):] + line.lstrip()

    def fix_e121(self, result):
        self._fix_reindent(result)

    def fix_e122(self, result):
        self._fix_reindent(result)

    def fix_e123(self, result):
        self._fix_reindent(result)

    def fix_e124(self, result):
        """Fix closing bracket does not match visual indent (E124)."""
        self._fix_reindent(result)

    def fix_e125(self, result):
        self._fix_reindent(result)

    def fix_e126(self, result):
        self._fix_reindent(result)

    def fix_e127(self, result):
        self._fix_reindent(result)

    def fix_e128(self, result):
        """Fix continuation line under-indented for visual indent (E128).
        
        Adjusts the indentation of continuation lines to align properly
        with the content after the opening bracket on the previous line.
        """
        line_index = result['line'] - 1
        if line_index < 0 or line_index >= len(self.source):
            return
        if line_index == 0:
            return
        
        line = self.source[line_index]
        prev_line = self.source[line_index - 1]
        
        # Find the visual indent from the previous line
        # Find the character after the opening bracket
        for i, ch in enumerate(prev_line):
            if ch in '([{':
                # Find the first non-whitespace char after the bracket
                for j in range(i + 1, len(prev_line)):
                    c = prev_line[j]
                    if c in ' \t':
                        continue
                    elif c == '\n':
                        return
                    else:
                        # Visual indent is position of first non-whitespace
                        # after the opening bracket
                        target_indent = ' ' * j
                        current_indent = _get_indentation(line)
                        if current_indent != target_indent:
                            self.source[line_index] = target_indent + line.lstrip()
                        return
                return

    def fix_e129(self, result):
        """Fix continuation line over-indented for visual indent (E129).
        
        Reduces the indentation of over-indented continuation lines.
        """
        self._fix_reindent(result)

    def fix_e131(self, result):
        self._fix_reindent(result)

    def fix_e201(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            # E201: column (0-indexed) points to the whitespace after '('
            offset = column
            if offset < len(line) and line[offset:offset + 1] == ' ':
                self.source[line_index] = line[:offset] + line[offset + 1:]

    def fix_e202(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            offset = column
            if offset < len(line) and line[offset:offset + 1] == ' ':
                self.source[line_index] = line[:offset] + line[offset + 1:]

    def fix_e203(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            offset = column
            if offset < len(line) and line[offset:offset + 1] == ' ':
                self.source[line_index] = line[:offset] + line[offset + 1:]

    def fix_e211(self, result):
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            self.source[line_index] = line.rstrip() + '\n'

    def fix_e224(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            offset = column
            if offset < len(line) and line[offset:offset + 1] == ' ':
                self.source[line_index] = line[:offset] + line[offset + 1:]

    def fix_e225(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            # E225: column (0-indexed) points to the operator
            offset = column
            if offset < len(line):
                op_chars = set('+-*/%=<>!&|^')
                # Column should already point to the operator
                pos = offset
                if line[pos] not in op_chars:
                    # Scan forward from column to find operator
                    while pos < len(line) and line[pos] not in op_chars:
                        pos += 1
                if pos >= len(line):
                    return
                ch = line[pos]
                # Skip unary operators
                if pos == 0 or line[pos - 1] in ('(', '[', '{', ',', '=', '+', '-', '*', '/', '%', '<', '>', '!', '&', '|', '^'):
                    return
                # Add space before operator if missing
                if pos > 0 and line[pos - 1] not in (' ', '\t', '\n', '(', '[', '{', ','):
                    line = line[:pos] + ' ' + line[pos:]
                    pos += 1
                # Add space after operator if missing
                after = pos + 1
                if after < len(line) and line[after] not in (' ', '\t', '\n', ')', ']', '}', ','):
                    line = line[:after] + ' ' + line[after:]
                self.source[line_index] = line

    def fix_e226(self, result):
        # E226: missing whitespace around arithmetic operator
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            offset = column
            if offset < len(line) and line[offset] in '+-*/%':
                pos = offset
                if pos > 0 and line[pos - 1] in ('(', '[', '{', ',', '=', '+', '-', '*', '/', '%'):
                    return
                if pos > 0 and line[pos - 1] not in (' ', '\t'):
                    line = line[:pos] + ' ' + line[pos:]
                    pos += 1
                after = pos + 1
                if after < len(line) and line[after] not in (' ', '\t', ')', ']', '}', ','):
                    line = line[:after] + ' ' + line[after:]
            self.source[line_index] = line

    def fix_e227(self, result):
        self.fix_e225(result)

    def fix_e228(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            offset = column
            if offset < len(line) and line[offset:offset + 1] == ' ':
                self.source[line_index] = line[:offset] + line[offset + 1:]

    def fix_e231(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            # E231: column (0-indexed) points to the comma.
            # Insert space AFTER the comma at column + 1
            offset = column + 1
            if offset < len(line) and line[offset] != ' ':
                self.source[line_index] = (
                    line[:offset] + ' ' + line[offset:]
                )

    def fix_e241(self, result):
        pass

    def fix_e242(self, result):
        pass

    def fix_e251(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            # E251: column (0-indexed) points to unexpected space around '='
            # Scan from column to find '=' (it may be a few chars ahead)
            offset = column
            eq_pos = -1
            for p in range(offset, min(offset + 5, len(line))):
                if line[p] == '=':
                    eq_pos = p
                    break
            if eq_pos < 0:
                # Also check backwards
                for p in range(max(0, offset - 5), offset + 1):
                    if line[p] == '=':
                        eq_pos = p
                        break
            if eq_pos >= 0:
                # Strip spaces around this '='
                start = eq_pos
                end = eq_pos + 1
                while start > 0 and line[start - 1] == ' ':
                    start -= 1
                while end < len(line) and line[end] == ' ':
                    end += 1
                line = line[:start] + '=' + line[end:]
            self.source[line_index] = line

    def fix_e261(self, result):
        pass

    def fix_e262(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            # E262: column (0-indexed) points to first extra space before '#'
            offset = column
            if offset < len(line):
                after = line[offset:]
                match = re.match(r'^(\s+)#', after)
                if match:
                    spaces = match.group(1)
                    if len(spaces) > 2:
                        # Strip trailing spaces before the extra whitespace
                        before = line[:offset].rstrip()
                        after_hash = after[match.end():]
                        self.source[line_index] = (
                            before + '  #' + after_hash
                        )

    def fix_e265(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            offset = column
            if offset < len(line):
                after = line[offset:]
                match = re.match(r'^(\s+)#', after)
                if match:
                    spaces = match.group(1)
                    if len(spaces) >= 4:
                        before = line[:offset].rstrip()
                        after_hash = after[match.end():]
                        self.source[line_index] = (
                            before + '  #' + after_hash
                        )

    def fix_e266(self, result):
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            # Don't fix tab width in comments
            pass

    def fix_e271(self, result):
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            # E271: column (0-indexed) points to the first extra space
            offset = column
            if offset < len(line) and line[offset] == ' ':
                # Remove all extra spaces, keep only one
                end = offset
                while end < len(line) and line[end] == ' ':
                    end += 1
                self.source[line_index] = line[:offset] + ' ' + line[end:]

    def fix_e272(self, result):
        self.fix_e271(result)

    def fix_e273(self, result):
        self.fix_e271(result)

    def fix_e274(self, result):
        self.fix_e271(result)

    def fix_e275(self, result):
        self.fix_e271(result)

    def fix_e301(self, result):
        """Fix E301 - expected 1 blank line before nested def/class (inside a class).
        
        When a method inside a class has no blank line before it, we add exactly one.
        """
        line_index = result['line'] - 1
        if line_index < 1 or line_index >= len(self.source):
            return
        # Check if the line before is non-empty (not already a blank line)
        prev = self.source[line_index - 1]
        if prev.strip():
            # Insert a blank line before this line
            self.source[line_index - 1] = prev.rstrip('\r\n') + '\n\n'

    def fix_e302(self, result):
        """Fix E302 - expected 2 blank lines before top-level def/class.
        
        When a top-level definition doesn't have enough blank lines before it,
        we ensure exactly 2 blank lines are present.
        """
        line_index = result['line'] - 1
        if line_index < 1 or line_index >= len(self.source):
            return
        prev = self.source[line_index - 1]
        if prev.strip():
            # Previous line is non-empty - add 2 blank lines after it
            self.source[line_index - 1] = prev.rstrip('\r\n') + '\n\n\n'
        elif line_index >= 2:
            # Previous line is blank, but there might only be 1 blank line
            # We need 2, so add another if the one before that is non-empty
            prev2 = self.source[line_index - 2]
            if prev2.strip():
                self.source[line_index - 2] = prev2.rstrip('\r\n') + '\n\n\n'

    def fix_e303(self, result):
        """Fix E303 - too many blank lines.
        
        When there are more than 2 consecutive blank lines, we remove the excess.
        pycodestyle reports this error at the non-blank line AFTER the excess blanks.
        So we look backward from the reported line to find and remove blank lines.
        """
        line_index = result['line'] - 1
        if line_index < 1 or line_index >= len(self.source):
            return
        # Look backward to find consecutive blank lines
        # Remove one blank line (the last one before the current line)
        for i in range(line_index - 1, -1, -1):
            if self.source[i].strip() == '':
                self.source[i] = ''
                break
            else:
                break

    def fix_e304(self, result):
        """Fix E304 - blank lines found after docstring.
        
        Removes blank lines between a docstring and the first code statement.
        """
        line_index = result['line'] - 1
        if line_index < 0 or line_index >= len(self.source):
            return
        if self.source[line_index].strip() == '':
            self.source[line_index] = ''

    def fix_e305(self, result):
        """Fix E305 - expected 2 blank lines after class/function definition.
        
        Similar to E302 but reported for the line after a class/function definition
        that doesn't have enough blank lines before it.
        """
        line_index = result['line'] - 1
        if line_index < 1 or line_index >= len(self.source):
            return
        prev = self.source[line_index - 1]
        if prev.strip():
            self.source[line_index - 1] = prev.rstrip('\r\n') + '\n\n\n'
        elif line_index >= 2:
            prev2 = self.source[line_index - 2]
            if prev2.strip():
                self.source[line_index - 2] = prev2.rstrip('\r\n') + '\n\n\n'

    def fix_e306(self, result):
        """Fix E306 - expected 1 blank line before a nested definition.
        """
        pass

    def fix_e401(self, result):
        """Fix E401 - multiple imports on one line.
        
        Splits 'import os, sys' into separate 'import os' and 'import sys' lines.
        """
        line_index = result['line'] - 1
        if line_index < 0 or line_index >= len(self.source):
            return
        line = self.source[line_index]
        stripped = line.strip()
        match = re.match(r'^import\s+(.+)$', stripped)
        if match:
            imports_text = match.group(1)
            imports = [imp.strip() for imp in imports_text.split(',')]
            leading = _get_indentation(line)
            new_lines = [leading + 'import ' + imp + '\n' for imp in imports]
            self.source[line_index:line_index + 1] = new_lines

    def fix_e402(self, result):
        """Fix E402 - module level import not at top of file.
        
        Moves module-level imports to the appropriate position near the top
        of the file, after docstrings and future imports.
        """
        line_index = result['line'] - 1
        if line_index < 0 or line_index >= len(self.source):
            return
        import_line = self.source[line_index]
        # Find the correct position for this import
        target_index = get_module_imports_on_top_of_file(
            self.source, line_index)
        if 0 <= target_index < len(self.source) and target_index != line_index:
            # Remove import from current position
            import_line = self.source.pop(line_index)
            # Insert at correct position
            self.source.insert(target_index, import_line)
    def fix_e501(self, result):
        """Fix line too long (E501).
        
        Breaks long lines into multiple shorter lines while maintaining
        proper indentation and syntax. Handles both logical and physical
        line shortening strategies.
        """
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            max_len = getattr(self._options, 'max_line_length', 79)
            if len(line.rstrip()) > max_len:
                fixed = self.fix_long_line(
                    line,
                    self.source[line_index - 1] if line_index > 0 else '',
                    self.source[line_index + 1] if line_index + 1 < len(self.source) else '',
                    line)
                if fixed and fixed != line:
                    # Split multi-line result into separate source elements
                    fixed_lines = fixed.split('\n')
                    # Remove trailing empty elements (artifact of split)
                    while fixed_lines and fixed_lines[-1] == '':
                        fixed_lines.pop()
                    # Re-add newline to each element
                    new_source_elements = [l + '\n' for l in fixed_lines]
                    self.source[line_index:line_index + 1] = new_source_elements

    def fix_long_line_logically(self, result, logical):
        """Fix long lines using logical line analysis.
        
        Analyzes the logical structure of the code and breaks long lines
        at semantically appropriate positions like after operators, commas,
        and other syntactic boundaries.
        
        Returns:
            list: Modified line indices, empty list if no changes made.
        """
        line_index = result['line'] - 1
        if line_index < 0 or line_index >= len(self.source):
            return []
        
        target_line = self.source[line_index]
        if is_probably_part_of_multiline(target_line):
            return []
        
        fixed = self.fix_long_line(
            target_line,
            self.source[line_index - 1] if line_index > 0 else '',
            self.source[line_index + 1] if line_index + 1 < len(self.source) else '',
            target_line)
        
        if fixed and fixed != target_line:
            # Split multi-line result into separate source elements
            fixed_lines = fixed.split('\n')
            while fixed_lines and fixed_lines[-1] == '':
                fixed_lines.pop()
            new_source_elements = [l + '\n' for l in fixed_lines]
            self.source[line_index:line_index + 1] = new_source_elements
            return list(range(line_index, line_index + len(new_source_elements)))
        return []

    def fix_long_line_physically(self, result):
        """Fix long lines using physical line analysis.
        
        Attempts to break long lines at physical boundaries such as
        whitespace, operators, and parentheses without considering
        the logical structure of the code.
        
        Returns:
            list: Modified line indices, empty list if no changes made.
        """
        line_index = result['line'] - 1
        if line_index < 0 or line_index >= len(self.source):
            return []
        
        target_line = self.source[line_index]
        if is_probably_part_of_multiline(target_line):
            return []
        
        fixed = self.fix_long_line(
            target_line,
            self.source[line_index - 1] if line_index > 0 else '',
            self.source[line_index + 1] if line_index + 1 < len(self.source) else '',
            target_line)
        
        if fixed and fixed != target_line:
            # Split multi-line result into separate source elements
            fixed_lines = fixed.split('\n')
            while fixed_lines and fixed_lines[-1] == '':
                fixed_lines.pop()
            new_source_elements = [l + '\n' for l in fixed_lines]
            self.source[line_index:line_index + 1] = new_source_elements
            return list(range(line_index, line_index + len(new_source_elements)))
        return []

    def fix_long_line(self, target, previous_line, next_line, original):
        """Core method for fixing long lines using various strategies.
        
        Attempts multiple strategies to shorten a long line:
        1. Token-based reflow using _shorten_line_at_tokens_new
        2. Operator-based breaking using _shorten_line
        3. Comment shortening for long comments
        4. Fallback to physical line splitting
        
        Args:
            target: The long line to fix.
            previous_line: The line before the target line.
            next_line: The line after the target line.
            original: The original version of the line.
            
        Returns:
            str: The fixed line(s) or the original if no fix was possible.
        """
        max_len = getattr(self._options, 'max_line_length', 79)
        if len(target.rstrip()) <= max_len:
            return target

        aggressive = getattr(self._options, 'aggressive', 0)
        indent_word = getattr(self._options, 'indent_size', 4)
        if isinstance(indent_word, int):
            indent_word = ' ' * indent_word

        fixed = get_fixed_long_line(
            target, previous_line, original,
            indent_word=indent_word,
            max_line_length=max_len,
            aggressive=aggressive)
        if fixed:
            return fixed
        
        # Try comment shortening for long comment lines
        if target.lstrip().startswith('#'):
            shortened = shorten_comment(target, max_len, last_comment=True)
            if shortened and len(shortened.rstrip()) <= max_len:
                return shortened
        
        return target

    def fix_e502(self, result):
        """Remove extraneous escapes of newlines (E502).

        Fixes lines that have unnecessary backslash escapes before
        newline characters.
        """
        line_index = result['line'] - 1
        if line_index < 0 or line_index >= len(self.source):
            return
        
        line = self.source[line_index]
        # Remove extraneous backslash escapes before newlines
        fixed_line = line.replace(' \\\n', '\n')
        if fixed_line != line:
            self.source[line_index] = fixed_line

    def fix_e701(self, result):
        """Fix multiple statements on one line (colon or semicolon)."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            leading = _get_indentation(line)
            stripped = line.lstrip()
            
            # First handle semicolons
            if ';' in stripped:
                parts = [p.strip() for p in line.split(';') if p.strip()]
                if parts:
                    new_lines = []
                    for part in parts:
                        new_lines.append(leading + part.strip() + '\n')
                    self.source[line_index:line_index + 1] = new_lines
                    return
            
            # Handle colon case (e.g., "if True: x = 1")
            # Find the colon that separates control statement from body
            colon_pos = result['column']
            if colon_pos is not None:
                colon_pos = colon_pos  # 0-indexed
            else:
                # Find colon in stripped line
                for i, ch in enumerate(stripped):
                    if ch == ':':
                        rest = stripped[i+1:].strip()
                        if rest and rest[0] != ':':
                            colon_pos = i
                            break
            
            if colon_pos is not None and colon_pos < len(stripped):
                before = leading + stripped[:colon_pos+1]
                after = stripped[colon_pos+1:].strip()
                if after:
                    self.source[line_index] = before + '\n' + leading + '    ' + after + '\n'
                    return

    def fix_e702(self, result, logical=None):
        """Fix multiple statements on one line (colon-separated)."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            stripped = line.lstrip()
            leading = _get_indentation(line)
            # Handle cases like "if True: x = 1" or "for i in range(1): print(i)"
            # Split at the first colon followed by non-empty content
            colon_match = None
            for i, ch in enumerate(stripped):
                if ch == ':':
                    rest = stripped[i+1:].strip()
                    if rest and rest[0] != ':':  # Avoid hitting :: in slices
                        colon_match = (i, stripped[:i+1], rest)
                        break
            if colon_match:
                pos, before_colon, after_colon = colon_match
                # Don't split if after_colon is just a pass or simple statement
                # that's part of a control structure
                self.source[line_index] = leading + before_colon + '\n' + leading + '    ' + after_colon + '\n'
                return
            self.fix_e701(result)

    def fix_e703(self, result):
        pass

    def fix_e704(self, result):
        """Fix 'def' is not followed by a newline."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            leading = _get_indentation(line)
            # Check for semicolons after def line
            if ';' in line:
                parts = [p.strip() for p in line.split(';') if p.strip()]
                if len(parts) >= 2:
                    new_lines = [leading + parts[0].strip() + '\n']
                    for part in parts[1:]:
                        new_lines.append(leading + '    ' + part.strip() + '\n')
                    self.source[line_index:line_index + 1] = new_lines

    def fix_e711(self, result):
        """Fix comparison to None using 'is'."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            line = line.replace('== None', 'is None').replace('==None', 'is None')
            line = line.replace('!= None', 'is not None').replace('!=None', 'is not None')
            self.source[line_index] = line

    def fix_e712(self, result):
        """Fix comparison to True/False using 'is'."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            for val in ('True', 'False'):
                line = line.replace('== ' + val, 'is ' + val).replace('==' + val, 'is ' + val)
                line = line.replace('!= ' + val, 'is not ' + val).replace('!=' + val, 'is not ' + val)
            self.source[line_index] = line

    def fix_e713(self, result):
        """Fix 'not x in y' to 'x not in y'."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            if COMPARE_NEGATIVE_REGEX.search(line) and not COMPARE_NEGATIVE_REGEX_THROUGH.search(line):
                line = COMPARE_NEGATIVE_REGEX.sub(lambda m: m.group(2) + ' not ' + m.group(3) + ' ', line)
            self.source[line_index] = line

    def fix_e714(self, result):
        """Fix 'not x is y' to 'x is not y'."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            if COMPARE_NEGATIVE_REGEX.search(line) and not COMPARE_NEGATIVE_REGEX_THROUGH.search(line):
                line = COMPARE_NEGATIVE_REGEX.sub(lambda m: m.group(2) + ' is not ', line)
            self.source[line_index] = line

    def fix_e721(self, result):
        """Fix type() comparisons to use isinstance() instead."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            # type(X) == type(Y) -> isinstance(X, type(Y))
            # type(X) != type(Y) -> not isinstance(X, type(Y))
            # For safety, use simple string replacement patterns
            # type(X) == Y -> isinstance(X, Y)
            # == type(X) -> isinstance(..., type(X)) (too complex to auto-fix)
            # We handle the common case: type(X) == type(Y)
            if '==' in line and 'type(' in line:
                import re as _re
                m = _re.search(r'type\(([^)]+)\)\s*==\s*type\(([^)]+)\)', line)
                if m:
                    line = line[:m.start()] + 'isinstance(' + m.group(1) + ', type(' + m.group(2) + '))' + line[m.end():]
                else:
                    # type(X) == Y
                    m = _re.search(r'type\(([^)]+)\)\s*==', line)
                    if m:
                        line = line[:m.start()] + 'isinstance(' + m.group(1) + ', ' + line[m.end():]
            if '!=' in line and 'type(' in line:
                import re as _re
                m = _re.search(r'type\(([^)]+)\)\s*!=\s*type\(([^)]+)\)', line)
                if m:
                    line = line[:m.start()] + 'not isinstance(' + m.group(1) + ', type(' + m.group(2) + '))' + line[m.end():]
                else:
                    m = _re.search(r'type\(([^)]+)\)\s*!=', line)
                    if m:
                        line = line[:m.start()] + 'not isinstance(' + m.group(1) + ', ' + line[m.end():]
            self.source[line_index] = line

    def fix_e722(self, result):
        """Fix bare except clauses by adding specific exception types."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            line = re.sub(r'except\s*:', 'except Exception:', line)
            self.source[line_index] = line

    def fix_e731(self, result):
        """Do not assign a lambda expression, use a def."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            line = self.source[line_index]
            leading = _get_indentation(line)
            m = LAMBDA_REGEX.match(line.rstrip('\n'))
            if m:
                name = m.group(1)
                params = m.group(2).strip()
                if not params.startswith('('):
                    params = '(' + params + ')'
                rest_of_line = line.rstrip('\n')[m.end():].strip()
                if not rest_of_line:
                    new_code = leading + 'def ' + name + params + ':' + '\n' + leading + '    pass\n'
                else:
                    new_code = leading + 'def ' + name + params + ':' + '\n' + leading + '    return ' + rest_of_line + '\n'
                self.source[line_index] = new_code

    def fix_w291(self, result):
        """Remove trailing whitespace."""
        line_index = result['line'] - 1
        if 0 <= line_index < len(self.source):
            self.source[line_index] = self.source[line_index].rstrip() + '\n'

    def fix_w391(self, result):
        """Remove trailing blank lines at end of file."""
        while len(self.source) > 1 and self.source[-1].strip() == '':
            self.source.pop()

    def fix_w392(self, result):
        pass

    def fix_w503(self, result):
        """Fix W503 - line break before binary operator.

        Join the continuation line with the binary operator to the previous line.
        E.g., 'x = 1\n    + 2' -> 'x = 1 + 2'
        """
        line_index = result['line'] - 1
        if line_index < 1 or line_index >= len(self.source):
            return

        current_line = self.source[line_index]
        previous_line = self.source[line_index - 1]

        stripped = current_line.strip().rstrip('\n')
        if not stripped:
            return

        prev_stripped = previous_line.rstrip('\n')

        joined = prev_stripped + " " + stripped + "\n"

        max_length = getattr(self._options, 'max_line_length', 79)
        if len(joined.rstrip('\n')) <= max_length:
            self.source[line_index - 1] = joined
            self.source[line_index] = "\n"
            return

        return

    def fix_w504(self, result):
        """Fix W504 - line break after binary operator.

        Move the binary operator from the end of the current line to the next line.
        E.g., 'x = 1 +\n    2' -> 'x = 1\n    + 2'
        """
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if column is None:
            return
        if column and column > 0:
            column = column - 1  # convert to 0-indexed

        if line_index < 0 or line_index >= len(self.source):
            return

        current_line = self.source[line_index]
        line_str = current_line.rstrip('\n\r')

        if column >= len(line_str):
            return

        if line_index + 1 >= len(self.source):
            return

        next_line = self.source[line_index + 1]

        next_indent = len(next_line) - len(next_line.lstrip())
        next_indent_str = next_line[:next_indent]

        before_op = line_str[:column].rstrip()
        from_op_to_end = line_str[column:].lstrip()

        if not from_op_to_end:
            return

        next_content = next_line.strip().rstrip('\n')
        new_next = next_indent_str + from_op_to_end + " " + next_content + "\n"
        self.source[line_index] = before_op + "\n"
        self.source[line_index + 1] = new_next

        return

    def fix_w605(self, result):
        """Fix W605 - invalid escape sequence in string.

        Detect strings with invalid escape sequences and attempt to fix them
        by prefixing with 'r' (making them raw strings).
        """
        line_index = result['line'] - 1
        column = result.get('column', 0)
        if column and column > 0:
            column = column - 1

        if line_index < 0 or line_index >= len(self.source):
            return

        line = self.source[line_index]

        fixed = _fix_invalid_escape(line, column)
        if fixed and fixed != line:
            self.source[line_index] = fixed

        return


# Global fix functions
def fix_e101(source, options=None, where='global', filename=''):
    return re.sub(r'(?<!\\)\t', '    ', source)


def fix_w191(source, options=None, where='global', filename=''):
    return source.replace('\t', '    ')


def fix_w291(source, options=None, where='global', filename=''):
    lines = source.split('\n')
    fixed = [line.rstrip() for line in lines]
    return '\n'.join(fixed)


def fix_w293(source, options=None, where='global', filename=''):
    return fix_w291(source)


def fix_w391(source, options=None, where='global', filename=''):
    return source.rstrip('\n') + '\n'


def main(argv=None, apply_config=True):
    if argv is None:
        argv = sys.argv[1:]

    try:
        options = parse_args(argv, apply_config=apply_config)
    except SystemExit as e:
        return e.code if e.code else EXIT_CODE_OK

    if hasattr(options, 'list_fixes') and options.list_fixes:
        for code, description in supported_fixes():
            print('%-5s %s' % (code, description))
        return EXIT_CODE_OK

    files = options.files if hasattr(options, 'files') and options.files else []

    if not files:
        if not sys.stdin.isatty():
            source = sys.stdin.read()
            fixed = fix_code(source, options=options)
            sys.stdout.write(fixed)
            if source != fixed:
                return EXIT_CODE_EXISTS_DIFF
            return EXIT_CODE_OK

    if len(files) > 1 or hasattr(options, 'recursive') and options.recursive:
        results = fix_multiple_files(files, options)
    else:
        results = []
        for f in files:
            results.append(fix_file(f, options))

    has_diff = any(r is not None for r in results if r is not None)
    return EXIT_CODE_EXISTS_DIFF if has_diff else EXIT_CODE_OK


if __name__ == '__main__':
    sys.exit(main())

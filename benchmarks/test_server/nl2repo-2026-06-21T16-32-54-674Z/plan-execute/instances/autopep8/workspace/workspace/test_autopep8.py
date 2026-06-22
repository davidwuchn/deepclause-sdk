"""Basic tests for autopep8 module covering fix_code, encoding detection, whitespace, and CLI."""
import argparse
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import autopep8


class TestFixCode(unittest.TestCase):
    def test_fix_code_basic(self):
        source = "def example():\n    x = 1; y = 2\n    return x + y\n"
        result = autopep8.fix_code(source)
        self.assertIn("x = 1\n", result)
        self.assertIn("y = 2\n", result)

    def test_fix_code_whitespace_around_operators(self):
        source = "x=1\n"
        result = autopep8.fix_code(source)
        self.assertEqual(result, "x = 1\n")

    def test_fix_code_trailing_whitespace(self):
        source = "x = 1   \n"
        result = autopep8.fix_code(source)
        self.assertEqual(result, "x = 1\n")

    def test_fix_code_import_normalization(self):
        source = "import os, sys\n"
        result = autopep8.fix_code(source)
        self.assertIn("import os\n", result)
        self.assertIn("import sys\n", result)

    def test_fix_code_multiple_statements(self):
        source = "x = 1; y = 2; z = 3\n"
        result = autopep8.fix_code(source)
        lines = result.strip().split('\n')
        self.assertGreaterEqual(len(lines), 2)

    def test_fix_code_whitespace_after_comma(self):
        source = "func(1,2,3)\n"
        result = autopep8.fix_code(source)
        self.assertIn("func(1, 2, 3)", result)

    def test_fix_code_empty_string(self):
        result = autopep8.fix_code("")
        self.assertEqual(result, "")

    def test_fix_code_no_changes_needed(self):
        source = "x = 1 + 2\n"
        result = autopep8.fix_code(source)
        self.assertEqual(result, source)

    def test_fix_code_bytes_input(self):
        source = b"x=1\n"
        result = autopep8.fix_code(source)
        self.assertIsInstance(result, str)
        self.assertIn("x = 1", result)

    def test_fix_code_with_options(self):
        source = "x=1\n"
        options = {"max_line_length": 79}
        result = autopep8.fix_code(source, options=options)
        self.assertIn("x = 1", result)

    def test_fix_code_bare_except(self):
        source = "try:\n    pass\nexcept:\n    pass\n"
        result = autopep8.fix_code(source, options={"aggressive": 2})
        self.assertIn("except Exception:", result)

    def test_fix_code_long_line(self):
        source = "print(111, 111, 111, 111, 222, 222, 222, 222, 222, 222, 222, 222, 222, 333, 333, 333, 333)\n"
        result = autopep8.fix_code(source)
        for line in result.split('\n'):
            if line.strip():
                self.assertLessEqual(len(line), 79)

    def test_fix_code_if_statement(self):
        source = "if True: x = 1\n"
        result = autopep8.fix_code(source)
        self.assertIn("if True:", result)
        self.assertIn("    x = 1", result)

    def test_fix_code_none_comparison(self):
        source = "if x == None:\n    pass\n"
        result = autopep8.fix_code(source, options={"aggressive": 2})
        self.assertIn("is None", result)

    def test_fix_code_lambda(self):
        source = "f = lambda x: x + 1\n"
        result = autopep8.fix_code(source, options={"aggressive": 2})
        self.assertIn("def f", result)

    def test_fix_code_blank_lines(self):
        source = "class MyClass:\n    def method1(self):\n        pass\n    def method2(self):\n        pass\n"
        result = autopep8.fix_code(source)
        self.assertIn("def method1", result)
        self.assertIn("def method2", result)

    def test_fix_code_trailing_blank_lines(self):
        source = "x = 1\n\n\n"
        result = autopep8.fix_code(source)
        self.assertEqual(result, "x = 1\n")

    def test_fix_code_invalid_escape(self):
        source = 'x = "\\nhello"\n'
        result = autopep8.fix_code(source, options={"aggressive": 1})
        self.assertTrue(len(result) > 0)

    def test_fix_code_not_in(self):
        source = "if not x in y:\n    pass\n"
        result = autopep8.fix_code(source, options={"aggressive": 1})
        self.assertIn("not in", result)


class TestFileEncodingDetection(unittest.TestCase):
    def test_detect_encoding_utf8(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', encoding='utf-8', delete=False) as f:
            f.write("# coding: utf-8\nx = 1\n")
            f.flush()
            encoding = autopep8.detect_encoding(f.name)
            self.assertEqual(encoding, 'utf-8')
            os.unlink(f.name)

    def test_detect_encoding_utf8_sig(self):
        with tempfile.NamedTemporaryFile(mode='wb', suffix='.py', delete=False) as f:
            f.write(b'\xef\xbb\xbf# -*- coding: utf-8 -*-\nx = 1\n')
            f.flush()
            encoding = autopep8.detect_encoding(f.name)
            self.assertIn('utf-8', encoding)
            os.unlink(f.name)

    def test_detect_encoding_latin1(self):
        with tempfile.NamedTemporaryFile(mode='wb', suffix='.py', delete=False) as f:
            f.write(b'# test\nx = "caf\xe9"\n')
            f.flush()
            encoding = autopep8.detect_encoding(f.name)
            self.assertIsInstance(encoding, str)
            os.unlink(f.name)

    def test_detect_encoding_default(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write("x = 1\n")
            f.flush()
            encoding = autopep8.detect_encoding(f.name)
            self.assertEqual(encoding, 'utf-8')
            os.unlink(f.name)

    def test_open_with_encoding(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', encoding='utf-8', delete=False) as f:
            f.write("x = 1\n")
            f.flush()
            with autopep8.open_with_encoding(f.name) as fh:
                content = fh.read()
                self.assertEqual(content, "x = 1\n")
            os.unlink(f.name)

    def test_readlines_from_file(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', encoding='utf-8', delete=False) as f:
            f.write("x = 1\ny = 2\nz = 3\n")
            f.flush()
            lines = autopep8.readlines_from_file(f.name)
            self.assertEqual(len(lines), 3)
            self.assertEqual(lines[0], "x = 1\n")
            os.unlink(f.name)

    def test_find_newline_lf(self):
        lines = ["x = 1\n", "y = 2\n"]
        newline = autopep8.find_newline(lines)
        self.assertEqual(newline, '\n')

    def test_find_newline_crlf(self):
        lines = ["x = 1\r\n", "y = 2\r\n"]
        newline = autopep8.find_newline(lines)
        self.assertEqual(newline, '\r\n')

    def test_find_newline_cr(self):
        lines = ["x = 1\r", "y = 2\r"]
        newline = autopep8.find_newline(lines)
        self.assertEqual(newline, '\r')

    def test_wrap_output(self):
        buf = io.BytesIO()
        wrapped = autopep8.wrap_output(buf, 'utf-8')
        wrapped.write("x = 1\n")
        self.assertIn(b"x = 1", buf.getvalue())


class TestWhitespaceFixing(unittest.TestCase):
    def test_whitespace_after_comma(self):
        result = autopep8.fix_code("func(1,2,3)\n")
        self.assertIn("func(1, 2, 3)", result)

    def test_whitespace_around_operator(self):
        result = autopep8.fix_code("x=1\n")
        self.assertEqual(result, "x = 1\n")

    def test_whitespace_after_parenthesis(self):
        result = autopep8.fix_code("func( 1)\n")
        self.assertIn("func(1)", result)

    def test_trailing_whitespace(self):
        result = autopep8.fix_code("x = 1   \n")
        self.assertEqual(result, "x = 1\n")

    def test_trailing_blank_lines(self):
        result = autopep8.fix_code("x = 1\n\n\n\n")
        self.assertEqual(result, "x = 1\n")

    def test_multiple_spaces_after_keyword(self):
        result = autopep8.fix_code("if   True:\n    pass\n")
        self.assertIn("if True:", result)

    def test_whitespace_around_equals(self):
        result = autopep8.fix_code("a=1+2\n")
        self.assertIn("a = 1+2", result)

    def test_parameter_whitespace(self):
        result = autopep8.fix_code("def f(a = 1):\n    pass\n")
        self.assertIn("def f(a=1):", result)

    def test_noqa_preserved(self):
        source = "x=1  # noqa\n"
        result = autopep8.fix_code(source)
        self.assertIn("# noqa", result)


class TestCommandLineInterface(unittest.TestCase):
    def test_parse_args_default(self):
        args = autopep8.parse_args([])
        self.assertEqual(args.max_line_length, 79)
        self.assertEqual(args.aggressive, 0)

    def test_parse_args_max_line_length(self):
        args = autopep8.parse_args(['--max-line-length', '100', 'test.py'])
        self.assertEqual(args.max_line_length, 100)

    def test_parse_args_aggressive(self):
        args = autopep8.parse_args(['--aggressive', 'test.py'])
        self.assertGreaterEqual(args.aggressive, 1)

    def test_parse_args_diff(self):
        args = autopep8.parse_args(['--diff', 'test.py'])
        self.assertTrue(args.diff)

    def test_parse_args_in_place(self):
        args = autopep8.parse_args(['--in-place', 'test.py'])
        self.assertTrue(args.in_place)

    def test_parse_args_ignore(self):
        args = autopep8.parse_args(['--ignore', 'E501', 'test.py'])
        self.assertIn('E501', args.ignore)

    def test_parse_args_select(self):
        args = autopep8.parse_args(['--select', 'E225,E701', 'test.py'])
        self.assertIn('E225', args.select)
        self.assertIn('E701', args.select)

    def test_create_parser(self):
        parser = autopep8.create_parser()
        self.assertIsInstance(parser, argparse.ArgumentParser)

    def test_main_list_fixes(self):
        result = autopep8.main(['--list-fixes'])
        self.assertEqual(result, 0)

    def test_main_version(self):
        result = autopep8.main(['--version'])
        self.assertEqual(result, 0)

    def test_fix_file(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write("x=1\n")
            f.flush()
            result = autopep8.fix_file(f.name)
            self.assertIn("x = 1", result)
            os.unlink(f.name)

    def test_fix_file_in_place(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write("x=1\n")
            f.flush()
            options = autopep8.parse_args(['-i', f.name])
            autopep8.fix_file(f.name, options=options)
            with open(f.name) as f2:
                self.assertIn("x = 1", f2.read())
            os.unlink(f.name)

    def test_fix_file_no_changes(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write("x = 1\n")
            f.flush()
            result = autopep8.fix_file(f.name)
            self.assertIsNone(result)
            os.unlink(f.name)

    def test_fix_file_diff_mode(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write("x=1\n")
            f.flush()
            options = autopep8.parse_args(['--diff', f.name])
            result = autopep8.fix_file(f.name, options=options)
            self.assertIsInstance(result, str)
            self.assertIn("---", result)
            self.assertIn("+++", result)
            os.unlink(f.name)

    def test_fix_multiple_files(self):
        files = []
        for i in range(3):
            with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
                f.write(f"x={i}\n")
                f.flush()
                files.append(f.name)
        options = autopep8.parse_args(files)
        results = autopep8.fix_multiple_files(files, options)
        self.assertEqual(len(results), 3)
        for r in results:
            self.assertIsInstance(r, str)
        for fp in files:
            os.unlink(fp)

    def test_is_python_file(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write("x = 1\n")
            f.flush()
            name = f.name
            self.assertTrue(autopep8.is_python_file(name))
            os.unlink(name)

    def test_is_python_file_non_python(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write("hello\n")
            f.flush()
            name = f.name
            self.assertFalse(autopep8.is_python_file(name))
            os.unlink(name)


class TestGetModuleImports(unittest.TestCase):
    def test_imports_after_docstring(self):
        source = ['"""Module docstring."""\n', 'import os\n', 'x = 1\n']
        index = autopep8.get_module_imports_on_top_of_file(source, 1)
        self.assertGreaterEqual(index, 0)

    def test_imports_at_top(self):
        source = ['import os\n', 'import sys\n', 'x = 1\n']
        index = autopep8.get_module_imports_on_top_of_file(source, 1)
        self.assertGreaterEqual(index, 0)

    def test_imports_after_future(self):
        source = ['from __future__ import division\n', 'import os\n', 'x = 1\n']
        index = autopep8.get_module_imports_on_top_of_file(source, 1)
        self.assertGreaterEqual(index, 0)

    def test_get_module_returns_int(self):
        source = ['import os\n']
        index = autopep8.get_module_imports_on_top_of_file(source, 0)
        self.assertIsInstance(index, int)


class TestUtilityFunctions(unittest.TestCase):
    def test_check_syntax_valid(self):
        self.assertTrue(autopep8.check_syntax("x = 1 + 2"))

    def test_check_syntax_invalid(self):
        self.assertFalse(autopep8.check_syntax("x = +"))

    def test_get_item_valid_index(self):
        self.assertEqual(autopep8.get_item([1, 2, 3], 1), 2)

    def test_get_item_out_of_bounds(self):
        self.assertEqual(autopep8.get_item([1, 2, 3], 10, default='missing'), 'missing')

    def test_mutual_startswith(self):
        self.assertTrue(autopep8.mutual_startswith("E501", "E5"))
        self.assertTrue(autopep8.mutual_startswith("E5", "E501"))
        self.assertFalse(autopep8.mutual_startswith("E501", "W5"))

    def test_code_match_select(self):
        self.assertTrue(autopep8.code_match("E501", ["E501"], []))
        self.assertFalse(autopep8.code_match("E502", ["E501"], []))

    def test_code_match_ignore(self):
        self.assertFalse(autopep8.code_match("E501", ["E501"], ["E501"]))

    def test_code_match_prefix(self):
        self.assertTrue(autopep8.code_match("E501", ["E5"], []))

    def test_split_and_strip_non_empty_lines(self):
        text = "line1\n\nline2\n  \nline3"
        result = autopep8.split_and_strip_non_empty_lines(text)
        self.assertEqual(result, ["line1", "line2", "line3"])

    def test_longest_line_length(self):
        code = "a = 1\nvery_long_line_here = 2\n"
        self.assertEqual(autopep8.longest_line_length(code), 23)

    def test_longest_line_length_empty(self):
        self.assertEqual(autopep8.longest_line_length(""), 0)

    def test_version(self):
        self.assertIsInstance(autopep8.__version__, str)
        self.assertGreater(len(autopep8.__version__), 0)

    def test_normalize_line_endings(self):
        lines = ["x = 1\r\n", "y = 2\r\n"]
        result = autopep8.normalize_line_endings(lines, "\n")
        self.assertEqual(result, ["x = 1\n", "y = 2\n"])

    def test_get_diff_text(self):
        old = ["x=1\n"]
        new = ["x = 1\n"]
        diff = autopep8.get_diff_text(old, new, "test.py")
        self.assertIn("---", diff)
        self.assertIn("+++", diff)

    def test_code_almost_equal(self):
        self.assertTrue(autopep8.code_almost_equal("x=1\n", "x = 1\n"))

    def test_find_disabled_ranges(self):
        source = "x = 1\n# autopep8: off\ny = 2\n# autopep8: on\nz = 3\n"
        ranges = autopep8.get_disabled_ranges(source)
        self.assertGreater(len(ranges), 0)

    def test_filter_disabled_results(self):
        result = {"line": 3}
        ranges = [(3, 3)]
        self.assertFalse(autopep8.filter_disabled_results(result, ranges))

    def test_shorten_comment(self):
        long_comment = "# " + "x" * 100 + "\n"
        shortened = autopep8.shorten_comment(long_comment, max_line_length=79)
        self.assertIsInstance(shortened, str)


class TestFixPEP8Class(unittest.TestCase):
    def test_fix_pep8_class_exists(self):
        fixer = autopep8.FixPEP8(
            filename='test.py',
            options=autopep8.parse_args(['test.py']),
            contents='x=1\n'
        )
        result = fixer.fix()
        self.assertIn("x = 1", result)

    def test_fix_pep8_whitespace(self):
        fixer = autopep8.FixPEP8(
            filename='test.py',
            options=autopep8.parse_args(['test.py']),
            contents='x=1\n'
        )
        result = fixer.fix()
        self.assertIn("x = 1", result)

    def test_fix_pep8_trailing_whitespace(self):
        fixer = autopep8.FixPEP8(
            filename='test.py',
            options=autopep8.parse_args(['test.py']),
            contents='x = 1   \n'
        )
        result = fixer.fix()
        self.assertEqual(result, "x = 1\n")

    def test_fix_pep8_imports(self):
        fixer = autopep8.FixPEP8(
            filename='test.py',
            options=autopep8.parse_args(['test.py']),
            contents='import os, sys\n'
        )
        result = fixer.fix()
        self.assertIn("import os\n", result)
        self.assertIn("import sys\n", result)


if __name__ == '__main__':
    unittest.main()

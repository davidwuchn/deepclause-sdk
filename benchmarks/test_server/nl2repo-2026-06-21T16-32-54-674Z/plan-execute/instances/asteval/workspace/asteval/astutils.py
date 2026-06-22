"""
asteval.astutils
================

Utility functions and constants for safe expression evaluation.

Provides fallback mechanisms for numpy imports, configuration constants,
symbol table builders, and AST helper utilities.
"""

import ast
import builtins
import math
import re
import sys
from sys import exc_info, stdout, stderr

# ---------------------------------------------------------------------------
# Numpy import with fallback
# ---------------------------------------------------------------------------
try:
    import numpy
    HAS_NUMPY = True
except Exception:
    HAS_NUMPY = False
    # Provide a minimal stub so that later code can still introspect safely
    class _NumpyStub:
        pass
    numpy = _NumpyStub()

try:
    import numpy_financial
    HAS_NUMPY_FINANCIAL = True
except Exception:
    HAS_NUMPY_FINANCIAL = False
    class _NumpyFinancialStub:
        pass
    numpy_financial = _NumpyFinancialStub()

# ---------------------------------------------------------------------------
# Security / limit constants
# ---------------------------------------------------------------------------
MAX_EXPONENT = 10000
MAX_STR_LEN = 2 << 17        # 256 KiB
MAX_SHIFT = 1000
MAX_OPEN_BUFFER = 2 << 17    # 256 KiB

# ---------------------------------------------------------------------------
# Reserved words / name validation
# ---------------------------------------------------------------------------
RESERVED_WORDS = (
    'False', 'None', 'True', 'and', 'as', 'assert',
    'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally',
    'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
    'return', 'try', 'while', 'with', 'yield', 'exec',
    'eval', 'execfile', '__import__', '__package__',
)

NAME_MATCH = re.compile(r'[a-zA-Z_][a-zA-Z0-9_]*$').match

UNSAFE_ATTRS = (
    '__subclasses__', '__bases__', '__globals__', '__code__',
    '__reduce__', '__reduce_ex__', '__mro__',
    '__closure__', '__func__', '__self__', '__module__',
    '__dict__', '__class__', '__call__', '__get__',
    '__getattribute__', '__subclasshook__', '__new__',
    '__init__', 'func_globals', 'func_code', 'func_closure',
    'im_class', 'im_func', 'im_self', 'gi_code', 'gi_frame',
    'f_locals', '__asteval__',
)

# ---------------------------------------------------------------------------
# Symbol table sources
# ---------------------------------------------------------------------------

# Python builtins to expose
FROM_PY = (
    'ArithmeticError', 'AssertionError', 'AttributeError',
    'BaseException', 'BufferError', 'BytesWarning',
    'DeprecationWarning', 'EOFError', 'EnvironmentError',
    'Exception', 'False', 'FloatingPointError', 'GeneratorExit',
    'IOError', 'ImportError', 'ImportWarning', 'IndentationError',
    'IndexError', 'KeyError', 'KeyboardInterrupt', 'LookupError',
    'MemoryError', 'NameError', 'None',
    'NotImplementedError', 'OSError', 'OverflowError',
    'ReferenceError', 'RuntimeError', 'RuntimeWarning',
    'StopIteration', 'SyntaxError', 'SyntaxWarning', 'SystemError',
    'SystemExit', 'True', 'TypeError', 'UnboundLocalError',
    'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError',
    'UnicodeTranslateError', 'UnicodeWarning', 'ValueError',
    'Warning', 'ZeroDivisionError', 'abs', 'all', 'any', 'bin',
    'bool', 'bytearray', 'bytes', 'chr', 'complex', 'dict', 'dir',
    'divmod', 'enumerate', 'filter', 'float', 'format', 'frozenset',
    'hash', 'hex', 'id', 'int', 'isinstance', 'len', 'list', 'map',
    'max', 'min', 'oct', 'ord', 'pow', 'range', 'repr',
    'reversed', 'round', 'set', 'slice', 'sorted', 'str', 'sum',
    'tuple', 'zip',
)

BUILTINS_TABLE = {sym: getattr(builtins, sym) for sym in FROM_PY if hasattr(builtins, sym)}

# math module functions to expose
FROM_MATH = (
    'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
    'ceil', 'copysign', 'cos', 'cosh', 'degrees', 'e', 'exp',
    'fabs', 'factorial', 'floor', 'fmod', 'frexp', 'fsum',
    'hypot', 'isinf', 'isnan', 'ldexp', 'log', 'log10', 'log1p',
    'modf', 'pi', 'pow', 'radians', 'sin', 'sinh', 'sqrt', 'tan',
    'tanh', 'trunc',
)

MATH_TABLE = {sym: getattr(math, sym) for sym in FROM_MATH if hasattr(math, sym)}

# numpy functions/constants to expose (only when HAS_NUMPY is True)
FROM_NUMPY = (
    'Inf', 'NAN', 'abs', 'add', 'all', 'amax', 'amin', 'angle',
    'any', 'append', 'arange', 'arccos', 'arccosh', 'arcsin',
    'arcsinh', 'arctan', 'arctan2', 'arctanh', 'argmax', 'argmin',
    'argsort', 'argwhere', 'around', 'array', 'array2string',
    'asanyarray', 'asarray', 'asarray_chkfinite',
    'ascontiguousarray', 'asfarray', 'asfortranarray', 'asmatrix',
    'atleast_1d', 'atleast_2d', 'atleast_3d', 'average', 'bartlett',
    'base_repr', 'bitwise_and', 'bitwise_not', 'bitwise_or',
    'bitwise_xor', 'blackman', 'broadcast', 'broadcast_arrays',
    'byte', 'c_', 'cdouble', 'ceil', 'cfloat', 'chararray', 'choose',
    'clip', 'clongdouble', 'clongfloat', 'column_stack',
    'common_type', 'complex128', 'complex64', 'complex_',
    'complexfloating', 'compress', 'concatenate', 'conjugate',
    'convolve', 'copy', 'copysign', 'corrcoef', 'correlate', 'cos',
    'cosh', 'cov', 'cross', 'csingle', 'cumprod', 'cumsum',
    'datetime_data', 'deg2rad', 'degrees', 'delete', 'diag',
    'diag_indices', 'diag_indices_from', 'diagflat', 'diagonal',
    'diff', 'digitize', 'divide', 'dot', 'double', 'dsplit',
    'dstack', 'dtype', 'e', 'ediff1d', 'empty', 'empty_like',
    'equal', 'exp', 'exp2', 'expand_dims', 'expm1', 'extract', 'eye',
    'fabs', 'fft', 'fill_diagonal', 'finfo', 'fix', 'flatiter',
    'flatnonzero', 'fliplr', 'flipud', 'float32', 'float64',
    'float_', 'floating', 'floor', 'floor_divide', 'fmax', 'fmin',
    'fmod', 'format_parser', 'frexp', 'frombuffer', 'fromfile',
    'fromfunction', 'fromiter', 'frompyfunc', 'fromregex',
    'fromstring', 'genfromtxt', 'getbufsize', 'geterr', 'gradient',
    'greater', 'greater_equal', 'hamming', 'hanning', 'histogram',
    'histogram2d', 'histogramdd', 'hsplit', 'hstack', 'hypot', 'i0',
    'identity', 'iinfo', 'imag', 'in1d', 'index_exp', 'indices',
    'inexact', 'inf', 'info', 'infty', 'inner', 'insert', 'int16',
    'int32', 'int64', 'int8', 'int_', 'intc', 'integer', 'interp',
    'intersect1d', 'intp', 'invert', 'iscomplex', 'iscomplexobj',
    'isfinite', 'isfortran', 'isinf', 'isnan', 'isneginf',
    'isposinf', 'isreal', 'isrealobj', 'isscalar', 'issctype',
    'iterable', 'ix_', 'kaiser', 'kron', 'ldexp', 'left_shift',
    'less', 'less_equal', 'linalg', 'linspace', 'little_endian',
    'load', 'loadtxt', 'log', 'log10', 'log1p', 'log2', 'logaddexp',
    'logaddexp2', 'logical_and', 'logical_not', 'logical_or',
    'logical_xor', 'logspace', 'longcomplex', 'longdouble',
    'longfloat', 'longlong', 'mask_indices', 'mat', 'matrix',
    'maximum', 'maximum_sctype', 'may_share_memory', 'mean',
    'median', 'memmap', 'meshgrid', 'mgrid', 'minimum',
    'mintypecode', 'mod', 'modf', 'msort', 'multiply', 'nan',
    'nan_to_num', 'nanargmax', 'nanargmin', 'nanmax', 'nanmin',
    'nansum', 'ndarray', 'ndenumerate', 'ndim', 'ndindex',
    'negative', 'newaxis', 'nextafter', 'nonzero', 'not_equal',
    'number', 'obj2sctype', 'ogrid', 'ones', 'ones_like', 'outer',
    'packbits', 'percentile', 'pi', 'piecewise', 'place', 'poly',
    'poly1d', 'polyadd', 'polyder', 'polydiv', 'polyfit', 'polyint',
    'polymul', 'polynomial', 'polysub', 'polyval', 'power', 'prod',
    'product', 'ptp', 'put', 'putmask', 'r_', 'rad2deg', 'radians',
    'random', 'ravel', 'real', 'real_if_close', 'reciprocal',
    'record', 'remainder', 'repeat', 'reshape', 'resize',
    'right_shift', 'rint', 'roll', 'rollaxis', 'roots', 'rot90',
    'round', 'round_', 'row_stack', 's_', 'sctype2char',
    'searchsorted', 'select', 'setbufsize', 'setdiff1d', 'seterr',
    'setxor1d', 'shape', 'short', 'sign', 'signbit', 'signedinteger',
    'sin', 'sinc', 'single', 'singlecomplex', 'sinh', 'size',
    'sometrue', 'sort', 'sort_complex', 'spacing', 'split', 'sqrt',
    'square', 'squeeze', 'std', 'str_', 'subtract', 'sum',
    'swapaxes', 'take', 'tan', 'tanh', 'tensordot', 'tile', 'trace',
    'transpose', 'trapz', 'tri', 'tril', 'tril_indices',
    'tril_indices_from', 'trim_zeros', 'triu', 'triu_indices',
    'triu_indices_from', 'true_divide', 'trunc', 'ubyte', 'uint',
    'uint16', 'uint32', 'uint64', 'uint8', 'uintc', 'uintp',
    'ulonglong', 'union1d', 'unique', 'unravel_index',
    'unsignedinteger', 'unwrap', 'ushort', 'vander', 'var', 'vdot',
    'vectorize', 'vsplit', 'vstack', 'where', 'who', 'zeros',
    'zeros_like',
)

NUMPY_RENAMES = {
    'ln': 'log',
    'asin': 'arcsin',
    'acos': 'arccos',
    'atan': 'arctan',
    'atan2': 'arctan2',
    'atanh': 'arctanh',
    'acosh': 'arccosh',
    'asinh': 'arcsinh',
}

FROM_NUMPY_FINANCIAL = (
    'fv', 'ipmt', 'irr', 'mirr', 'nper', 'npv',
    'pmt', 'ppmt', 'pv', 'rate',
)

# ---------------------------------------------------------------------------
# Local safe function placeholders (implemented later in this module)
# ---------------------------------------------------------------------------
# These are defined after the function bodies below to avoid forward-ref issues

# ---------------------------------------------------------------------------
# Safe operation helpers
# ---------------------------------------------------------------------------

def _open(filename, mode='r', buffering=-1, encoding=None):
    """read only version of open()"""
    # Only allow read-only modes
    if not mode.startswith('r'):
        raise RuntimeError('asteval open() only supports read-only modes')
    # Limit buffer size
    if buffering > 0 and buffering > MAX_OPEN_BUFFER:
        buffering = MAX_OPEN_BUFFER
    return open(filename, mode, buffering, encoding)


def _type(obj):
    """type that prevents varargs and varkws"""
    return type(obj).__name__


def safe_pow(base, exp):
    """safe version of pow"""
    if isinstance(exp, (int, float)):
        if abs(exp) > MAX_EXPONENT:
            raise RuntimeError(f'Exponentiation limited to exponent size of {MAX_EXPONENT}')
    return base ** exp


def safe_mult(arg1, arg2):
    """safe version of multiply"""
    # Protect against string/sequence length overflow
    if isinstance(arg1, str) and isinstance(arg2, int):
        if len(arg1) * arg2 > MAX_STR_LEN:
            raise RuntimeError(f'String length exceeds maximum of {MAX_STR_LEN}')
    if isinstance(arg2, str) and isinstance(arg1, int):
        if len(arg2) * arg1 > MAX_STR_LEN:
            raise RuntimeError(f'String length exceeds maximum of {MAX_STR_LEN}')
    result = arg1 * arg2
    if isinstance(result, (str, bytes, list, tuple)):
        if len(result) > MAX_STR_LEN:
            raise RuntimeError(f'Result length exceeds maximum of {MAX_STR_LEN}')
    return result


def safe_add(arg1, arg2):
    """safe version of add"""
    result = arg1 + arg2
    if isinstance(result, (str, bytes, list, tuple)):
        if len(result) > MAX_STR_LEN:
            raise RuntimeError(f'Result length exceeds maximum of {MAX_STR_LEN}')
    return result


def safe_lshift(arg1, arg2):
    """safe version of lshift"""
    if arg2 > MAX_SHIFT:
        raise RuntimeError(f'Left shift limited to {MAX_SHIFT} bits')
    return arg1 << arg2


# ---------------------------------------------------------------------------
# Operator mapping
# ---------------------------------------------------------------------------
OPERATORS = {
    ast.Is: lambda a, b: a is b,
    ast.IsNot: lambda a, b: a is not b,
    ast.In: lambda a, b: a in b,
    ast.NotIn: lambda a, b: a not in b,
    ast.Add: safe_add,
    ast.BitAnd: lambda a, b: a & b,
    ast.BitOr: lambda a, b: a | b,
    ast.BitXor: lambda a, b: a ^ b,
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.LShift: safe_lshift,
    ast.RShift: lambda a, b: a >> b,
    ast.Mult: safe_mult,
    ast.Pow: safe_pow,
    ast.MatMult: lambda a, b: a @ b,
    ast.Sub: lambda a, b: a - b,
    ast.Mod: lambda a, b: a % b,
    ast.And: lambda a, b: a and b,
    ast.Or: lambda a, b: a or b,
    ast.Eq: lambda a, b: a == b,
    ast.Gt: lambda a, b: a > b,
    ast.GtE: lambda a, b: a >= b,
    ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b,
    ast.NotEq: lambda a, b: a != b,
    ast.Invert: lambda a: ~a,
    ast.Not: lambda a: not a,
    ast.UAdd: lambda a: +a,
    ast.USub: lambda a: -a,
}

LOCALFUNCS = {'open': _open, 'type': _type}


def op2func(oper):
    """Return function for operator nodes."""
    return OPERATORS.get(oper, None)


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def valid_symbol_name(name):
    """Determine whether the input symbol name is a valid name.

    Arguments
    ---------
      name  : str
         name to check for validity.

    Returns
    --------
      valid :  bool
        whether name is a a valid symbol name

    This checks for Python reserved words and that the name matches
    the regular expression ``[a-zA-Z_][a-zA-Z0-9_]``
    """
    if name in RESERVED_WORDS:
        return False
    return NAME_MATCH(name) is not None


def valid_varname(name):
    """is this a valid variable name"""
    return valid_symbol_name(name)


# ---------------------------------------------------------------------------
# AST name extraction
# ---------------------------------------------------------------------------

def get_ast_names(astnode):
    """Return symbol Names from an AST node."""
    finder = NameFinder()
    finder.generic_visit(astnode)
    return finder.names


# ---------------------------------------------------------------------------
# NameFinder visitor
# ---------------------------------------------------------------------------

class NameFinder(ast.NodeVisitor):
    """Find all symbol names used by a parsed node."""

    def __init__(self):
        """TODO: docstring in public method."""
        self.names = []
        ast.NodeVisitor.__init__(self)

    def generic_visit(self, node):
        """TODO: docstring in public method."""
        if node.__class__.__name__ == 'Name':
            if node.id not in self.names:
                self.names.append(node.id)
        ast.NodeVisitor.generic_visit(self, node)


# ---------------------------------------------------------------------------
# Helper classes
# ---------------------------------------------------------------------------

class Empty:
    """Empty class."""
    def __init__(self):
        """TODO: docstring in public method."""
        return

    def __nonzero__(self):
        """Empty is falsy."""
        return False

    def __bool__(self):
        """Empty is falsy (Python 3)."""
        return False

    def __repr__(self):
        """Empty repr."""
        return "Empty"


ReturnedNone = Empty()


class ExceptionHolder:
    """Basic exception handler."""
    def __init__(self, node, exc=None, msg='', expr=None, lineno=None):
        """TODO: docstring in public method."""
        self.node = node
        self.expr = expr
        self.msg = msg
        self.exc = exc
        self.lineno = lineno
        self.exc_info = exc_info()
        if self.exc is None and self.exc_info[0] is not None:
            self.exc = self.exc_info[0]
        if self.msg == '' and self.exc_info[1] is not None:
            self.msg = self.exc_info[1]

    def get_error(self):
        """Retrieve error data.
        Return a tuple of the exception name and the error message.
        The exception name is the name of the exception class.
        The error message is the error message of the exception.
        """
        if self.exc is not None:
            exc_name = self.exc.__name__ if isinstance(self.exc, type) else type(self.exc).__name__
        elif self.exc_info[0] is not None:
            exc_name = self.exc_info[0].__name__
        else:
            exc_name = ''
        return (exc_name, str(self.msg))


class Group(dict):
    """
    Group: a container of objects that can be accessed either as an object attributes
    or dictionary  key/value.  Attribute names must follow Python naming conventions.
    """
    def __init__(self, name=None, searchgroups=None, **kws):
        if name is None:
            name = hex(id(self))
        self.__name__ = name
        dict.__init__(self, **kws)
        self._searchgroups = searchgroups

    def __setattr__(self, name, value):
        """Set an attribute."""
        if name == '_searchgroups' or name == '__name__':
            dict.__setattr__(self, name, value)
        else:
            self[name] = value

    def __getattr__(self, name, default=None):
        """Get an attribute.
        If the attribute is not found, return the default value.
        If the attribute is found, return the value.
        If the attribute is not found and no default value is provided, raise a KeyError.
        """
        try:
            return self[name]
        except KeyError:
            if default is not None:
                return default
            raise

    def __setitem__(self, name, value):
        """Set an item."""
        dict.__setitem__(self, name, value)

    def get(self, key, default=None):
        """Get an item.
        If the item is not found, return the default value.
        If the item is found, return the value.
        If the item is not found and no default value is provided, raise a KeyError.
        """
        try:
            return self[key]
        except KeyError:
            if default is not None:
                return default
            raise

    def __repr__(self):
        """Representation of the Group object.
        Return a string representation of the Group object.
        The string representation is a list of the keys in the Group object.
        """
        return f"Group({self.__name__}, {list(self.keys())})"

    def _repr_html_(self):
        """HTML representation for Jupyter notebook"""
        html = [f"<table><caption>Group('{self.__name__}')</caption>",
                "<tr><th>Attribute</th><th>DataType</th><th><b>Value</b></th></tr>"]
        for key, val in self.items():
            html.append(f"""
<tr><td>{key}</td><td><i>{type(val).__name__}</i></td>
    <td>{repr(val):.75s}</td>
</tr>""")
        html.append("</table>")
        return '\n'.join(html)


class Procedure:
    """Procedure: user-defined function for asteval.

    This stores the parsed ast nodes as from the 'functiondef' ast node
    for later evaluation.

    """

    def __init__(self, name, interp, doc=None, lineno=0,
                 body=None, args=None, kwargs=None,
                 vararg=None, varkws=None):
        """TODO: docstring in public method."""
        self.__ininit__ = True
        self.name = name
        self.__name__ = self.name
        self.__asteval__ = interp
        self.raise_exc = self.__asteval__.raise_exception
        self.__doc__ = doc
        self.body = body
        self.argnames = args
        self.kwargs = kwargs
        self.vararg = vararg
        self.varkws = varkws
        self.lineno = lineno
        self.__ininit__ = False

    def __setattr__(self, attr, val):
        """Set an attribute."""
        if not getattr(self, '__ininit__', False):
            if attr == '__asteval__':
                dict.__setattr__(self, attr, val)
                return
            if attr in ('body', 'argnames', 'kwargs', 'vararg', 'varkws',
                        'lineno', 'name', '__name__', '__doc__',
                        'raise_exc', '__ininit__', 'symtable', '_symtable'):
                dict.__setattr__(self, attr, val)
                return
            # User-defined attributes go into the symbol table of the
            # interpreter
            self.__asteval__.symtable[attr] = val
        else:
            dict.__setattr__(self, attr, val)

    def __dir__(self):
        return ['name']

    def __repr__(self):
        """TODO: docstring in magic method.
        Return a string representation of the Procedure object.
        The string representation is a list of the keys in the Procedure object.
        """
        return f"<asteval Procedure '{self.name}'>"

    def __call__(self, *args, **kwargs):
        """TODO: docstring in public method.
        Call the Procedure object.
        The Procedure object is called with the given arguments and keyword arguments.
        """
        # Build a temporary symbol table for the function call
        # This is handled by the Interpreter's on_call method
        interp = self.__asteval__
        return interp._run_procedure(self, *args, **kwargs)


# ---------------------------------------------------------------------------
# Symbol table builder
# ---------------------------------------------------------------------------

def make_symbol_table(use_numpy=True, nested=False, top=True, **kws):
    """Create a default symbol table with optional NumPy support and custom symbols.

    Parameters
    ----------
    use_numpy : bool, optional
        Whether to include symbols from NumPy, default is True
    nested : bool, optional
        Whether to create a nested symbol table instead of a plain dict, default is False
    top : bool, optional
        Whether this is the top-level table in a nested table, default is True
    **kws : dict
        Dictionary of user-defined symbols to add to the symbol table

    Returns
    -------
    dict
        A symbol table dictionary with built-in functions and optional user symbols
    """
    out = dict(BUILTINS_TABLE)
    out.update(MATH_TABLE)

    if HAS_NUMPY and use_numpy:
        for n in FROM_NUMPY:
            if hasattr(numpy, n):
                out[n] = getattr(numpy, n)
        # Handle numpy renames
        for alias, realname in NUMPY_RENAMES.items():
            if realname in out:
                out[alias] = out[realname]

        if HAS_NUMPY_FINANCIAL:
            for n in FROM_NUMPY_FINANCIAL:
                if hasattr(numpy_financial, n):
                    out[n] = getattr(numpy_financial, n)

    # Add local safe functions
    out.update(LOCALFUNCS)

    # Add user-defined symbols
    for key, val in kws.items():
        out[key] = val

    if nested and top:
        out = Group(name='top', **out)

    return out


# ---------------------------------------------------------------------------
# Module export list
# ---------------------------------------------------------------------------

__all__ = [
    'Interpreter', 'NameFinder', 'valid_symbol_name',
    'make_symbol_table', 'get_ast_names', '__version__',
    'Empty', 'ExceptionHolder', 'Group', 'Procedure',
    'HAS_NUMPY', 'HAS_NUMPY_FINANCIAL', 'MAX_EXPONENT', 'MAX_STR_LEN',
    'MAX_SHIFT', 'MAX_OPEN_BUFFER', 'RESERVED_WORDS', 'NAME_MATCH',
    'UNSAFE_ATTRS', 'FROM_PY', 'BUILTINS_TABLE', 'FROM_MATH', 'MATH_TABLE',
    'FROM_NUMPY', 'FROM_NUMPY_FINANCIAL', 'NUMPY_RENAMES',
    'LOCALFUNCS', 'OPERATORS', 'ReturnedNone',
    'op2func', 'valid_varname', '_open', '_type',
    'safe_pow', 'safe_mult', 'safe_add', 'safe_lshift',
]

"""asteval - a safe and restricted Python expression evaluator.

This module defines the configuration constants used by the Interpreter class
to control which AST node types are supported and how the interpreter behaves.
"""
import ast
import copy
import inspect
import sys
import time

from io import StringIO

from .astutils import (
    HAS_NUMPY, Procedure, Group, make_symbol_table, get_ast_names,
    RESERVED_WORDS, UNSAFE_ATTRS, OPERATORS
)

# All AST node types that the Interpreter can potentially handle.
# These correspond to the AST node class names (lower-cased) that the
# Interpreter has 'on_<node>' handler methods for.
ALL_NODES = [
    'arg', 'assert', 'assign', 'attribute', 'augassign', 'binop',
    'boolop', 'break', 'bytes', 'call', 'compare', 'constant',
    'continue', 'delete', 'dict', 'dictcomp', 'ellipsis', 'excepthandler',
    'expr', 'extslice', 'for', 'functiondef', 'if', 'ifexp',
    'import', 'importfrom', 'index', 'interrupt', 'list', 'listcomp',
    'module', 'name', 'nameconstant', 'num', 'pass', 'raise', 'repr',
    'return', 'set', 'setcomp', 'slice', 'str', 'subscript', 'try',
    'tuple', 'unaryop', 'while', 'with', 'formattedvalue', 'joinedstr'
]


# MINIMAL_CONFIG: disables most advanced features.
# Setting minimal=True in Interpreter() is equivalent to using this config.
# Disabled nodes: import, importfrom, if, for, while, try, with,
#   functiondef, ifexp, listcomp, dictcomp, setcomp, augassign,
#   assert, delete, raise, print
MINIMAL_CONFIG = {
    'import': False,
    'importfrom': False,
    'if': False,
    'for': False,
    'while': False,
    'try': False,
    'with': False,
    'functiondef': False,
    'ifexp': False,
    'listcomp': False,
    'dictcomp': False,
    'setcomp': False,
    'augassign': False,
    'assert': False,
    'delete': False,
    'raise': False,
    'print': False,
    'nested_symtable': False,
}


# DEFAULT_CONFIG: enables most features while keeping security restrictions.
# By default 'import' and 'importfrom' are disabled for safety, but all other
# nodes are enabled.
DEFAULT_CONFIG = {
    'import': False,
    'importfrom': False,
    'if': True,
    'for': True,
    'while': True,
    'try': True,
    'with': True,
    'functiondef': True,
    'ifexp': True,
    'listcomp': True,
    'dictcomp': True,
    'setcomp': True,
    'augassign': True,
    'assert': True,
    'delete': True,
    'raise': True,
    'print': True,
    'nested_symtable': False,
}


stdout = sys.stdout
stderr = sys.stderr


class Interpreter:
    """create an asteval Interpreter: a restricted, simplified interpreter
    of mathematical expressions using Python syntax.

    Parameters
    ----------
    symtable : dict or `None`
        dictionary or SymbolTable to use as symbol table (if `None`, one will be created).
    nested_symtable : bool, optional
        whether to use a new-style nested symbol table instead of a plain dict [False]
    user_symbols : dict or `None`
        dictionary of user-defined symbols to add to symbol table.
    writer : file-like or `None`
        callable file-like object where standard output will be sent.
    err_writer : file-like or `None`
        callable file-like object where standard error will be sent.
    use_numpy : bool
        whether to use functions from numpy.
    max_statement_length : int
        maximum length of expression allowed [50,000 characters]
    readonly_symbols : iterable or `None`
        symbols that the user can not assign to
    builtins_readonly : bool
        whether to blacklist all symbols that are in the initial symtable
    minimal : bool
        create a minimal interpreter: disable many nodes (see Note 1).
    config : dict
        dictionary listing which nodes to support (see note 2))

    Notes
    -----
    1. setting `minimal=True` is equivalent to setting a config with the following
       nodes disabled: ('import', 'importfrom', 'if', 'for', 'while', 'try', 'with',
       'functiondef', 'ifexp', 'listcomp', 'dictcomp', 'setcomp', 'augassign',
       'assert', 'delete', 'raise', 'print')
    2. by default 'import' and 'importfrom' are disabled, though they can be enabled.
    """
    def __init__(self, symtable=None, nested_symtable=False,
                 user_symbols=None, writer=None, err_writer=None,
                 use_numpy=True, max_statement_length=50000,
                 minimal=False, readonly_symbols=None,
                 builtins_readonly=False, config=None, **kws):

        self.config = copy.copy(MINIMAL_CONFIG if minimal else DEFAULT_CONFIG)
        if config is not None:
            self.config.update(config)
        self.config['nested_symtable'] = nested_symtable

        if user_symbols is None:
            user_symbols = {}
            if 'usersyms' in kws:
                user_symbols = kws.pop('usersyms')  # back compat, changed July, 2023, v 0.9.4

        if len(kws) > 0:
            for key, val in kws.items():
                if key.startswith('no_'):
                    node = key[3:]
                    if node in ALL_NODES:
                        self.config[node] = not val
                elif key.startswith('with_'):
                    node = key[5:]
                    if node in ALL_NODES:
                        self.config[node] = val

        self.writer = writer or stdout
        self.err_writer = err_writer or stderr
        self.max_statement_length = max(1, min(int(1e8), max_statement_length))

        self.use_numpy = HAS_NUMPY and use_numpy
        if symtable is None:
            symtable = make_symbol_table(nested=nested_symtable,
                                         use_numpy=self.use_numpy, **user_symbols)

        symtable['print'] = self._printer
        self.symtable = symtable
        self._interrupt = None
        self.error = []
        self.error_msg = None
        self.expr = None
        self.retval = None
        self._calldepth = 0
        self.lineno = 0
        self.code_text = []
        self.start_time = time.time()
        self.node_handlers = {}
        for node in ALL_NODES:
            handler = self.unimplemented
            if self.config.get(node, True):
                handler = getattr(self, f"on_{node}", self.unimplemented)
            self.node_handlers[node] = handler

        self.allow_unsafe_modules = self.config.get('import', False)

        # to rationalize try/except try/finally
        if 'try' in self.node_handlers:
            self.node_handlers['tryexcept'] = self.node_handlers['try']
            self.node_handlers['tryfinally'] = self.node_handlers['try']

        if readonly_symbols is None:
            self.readonly_symbols = set()
        else:
            self.readonly_symbols = set(readonly_symbols)

        if builtins_readonly:
            self.readonly_symbols |= set(self.symtable)

        self.no_deepcopy = [key for key, val in symtable.items()
                            if (callable(val)
                                or inspect.ismodule(val)
                                or 'numpy.lib.index_tricks' in repr(type(val)))]

    def remove_nodehandler(self, node):
        """remove support for a node
        returns current node handler, so that it
        might be re-added with add_nodehandler()
        """
        handler = self.node_handlers.get(node, self.unimplemented)
        self.node_handlers[node] = self.unimplemented
        return handler

    def set_nodehandler(self, node, handler=None):
        """set node handler or use current built-in default"""
        if handler is None:
            handler = getattr(self, f"on_{node}", self.unimplemented)
        self.node_handlers[node] = handler

    def user_defined_symbols(self):
        """Return a set of symbols that have been added to symtable after
        construction.

        I.e., the symbols from self.symtable that are not in
        self.no_deepcopy.

        Returns
        -------
        unique_symbols : set
            symbols in symtable that are not in self.no_deepcopy

        """
        return set(self.symtable.keys()) - set(self.no_deepcopy)

    def unimplemented(self, node):
        """Unimplemented nodes."""
        self.raise_exception(node, exc=NotImplementedError,
                             msg=f"Node type {node.__class__.__name__} not implemented")
        return None

    def raise_exception(self, node, exc=None, msg='', expr=None, lineno=None):
        """Add an exception."""
        from .astutils import ExceptionHolder
        if lineno is None:
            lineno = self.lineno
        if expr is None:
            expr = self.expr
        err = ExceptionHolder(node, exc=exc, msg=msg, expr=expr, lineno=lineno)
        self.error.append(err)
        self.error_msg = err.msg

    # main entry point for Ast node evaluation
    def parse(self, text):
        """Parse statement/expression to Ast representation."""
        try:
            return ast.parse(text)
        except SyntaxError:
            self.error_msg = "SyntaxError while parsing '%s'" % text
            raise

    def run(self, node, expr=None, lineno=None, with_raise=True):
        """Execute parsed Ast representation for an expression."""
        # Note: keep the 'node is None' test: internal code here may run
        #    run(None) and expect a None in return.
        if node is None:
            return None
        result = self.run_node(node, expr=expr, lineno=lineno, with_raise=with_raise)
        if result is not None:
            return result
        return self.retval

    def run_node(self, node, expr=None, lineno=None, with_raise=True):
        """Execute a single AST node."""
        if lineno is None:
            lineno = self.lineno
        if expr is None:
            expr = self.expr
        try:
            node_type = node.__class__.__name__.lower()
            handler = self.node_handlers.get(node_type)
            if handler is None:
                handler = self.unimplemented
            return handler(node)
        except Exception as e:
            if with_raise:
                self.raise_exception(node, exc=type(e), msg=str(e), expr=expr, lineno=lineno)
            raise
        return None

    def __call__(self, expr, **kw):
        """Call class instance as function."""
        return self.eval(expr, **kw)

    def eval(self, expr, lineno=0, show_errors=True, raise_errors=False):
        """Evaluate a single statement."""
        self.error = []
        self.error_msg = None
        self.expr = expr
        self.lineno = lineno
        self.retval = None
        if not hasattr(expr, '__len__'):
            self.retval = None
        else:
            if len(expr) > self.max_statement_length:
                self.error_msg = "expression length exceeds max_statement_length=%d" % (self.max_statement_length)
                err = RuntimeError(self.error_msg)
                self.raise_exception(None, exc=RuntimeError, msg=self.error_msg)
                if raise_errors:
                    raise err
                return None
        nodes = self.parse(expr)
        try:
            if isinstance(nodes, ast.Module):
                for node in nodes.body:
                    self.retval = self.run(node, expr=expr, lineno=lineno)
            else:
                self.retval = self.run(nodes, expr=expr, lineno=lineno)
        except SyntaxError:
            raise
        except Exception as e:
            if raise_errors:
                raise
        if show_errors and self.error:
            for err in self.error:
                self.err_writer.write(err.get_error()[1] + '\n')
        return self.retval

    @staticmethod
    def dump(node, **kw):
        """Simple ast dumper."""
        return ast.dump(node, **kw)

    # handlers for ast components
    def on_expr(self, node):
        """Expression."""
        return self.run(node.value)

    # imports
    def on_import(self, node):
        """Simple import: 'import foo' or 'import foo as bar'."""
        if not self.allow_unsafe_modules:
            self.raise_exception(node, msg="Import not allowed (disable with: with_import=True or config={'import': True})")
            return
        for alias in node.names:
            self.import_module(alias.name, alias.asname)


    def on_importfrom(self, node):
        """Import from: 'from foo import bar' or 'from foo import bar as baz'."""
        if not self.allow_unsafe_modules:
            self.raise_exception(node, msg="Import from not allowed (disable with: with_importfrom=True or config={'importfrom': True})")
            return
        names = [alias.name for alias in node.names]
        asnames = [alias.asname for alias in node.names]
        self.import_module(node.module, asnames, fromlist=names, level=node.level)

    def import_module(self, name, asname, fromlist=None, level=0):
        """import a python module, installing it into the symbol table.
        options:
          name       name of module to import 'foo' in 'import foo'
          asname     alias for imported name(s)
                          'bar' in 'import foo as bar'
                       or
                          ['s','t'] in 'from foo import x as s, y as t'
          fromlist   list of symbols to import with 'from-import'
                         ['x','y'] in 'from foo import x, y'
        """
        # Security: validate module name
        if name is None:
            self.raise_exception(None, msg="Cannot import: module name is None")
            return

        # List of modules that should never be importable for security reasons
        UNSAFE_MODULES = (
            '__builtin__', '__builtins__', 'builtins',
            'os', 'sys', 'subprocess', 'shutil', 'pickle',
            'marshal', 'code', 'codeop',
            'ctypes', 'socket', 'threading', 'multiprocessing',
            'importlib', 'concurrent', 'signal',
        )

        # Check if the top-level module is in the unsafe list
        top_level = name.split('.')[0]
        if top_level in UNSAFE_MODULES:
            self.raise_exception(None, msg=f"Import of unsafe module '{name}' is not allowed")
            return

        # find module in sys.modules or import to it
        mod = None
        try:
            mod = __import__(name, level=level)
        except Exception:
            self.raise_exception(None, msg=f"Cannot import {name}")
            return

        if fromlist is not None:
            for fname, faname in zip(fromlist, asname if isinstance(asname, list) else [asname]*len(fromlist)):
                if fname == '*':
                    # 'from mod import *' - disallow for security
                    self.raise_exception(None, msg="Import '*' not allowed for security")
                    return
                if hasattr(mod, fname):
                    sym = faname if faname else fname
                    self.symtable[sym] = getattr(mod, fname)
        else:
            if isinstance(asname, list):
                sym = asname[0] if asname else name
            else:
                sym = asname if asname else name
            self.symtable[sym] = mod
    def on_index(self, node):
        """Index."""
        return self.run(node.value)

    def on_return(self, node):
        """Return statement: look for None, return special sentinel."""
        if node.value is None:
            retval = None
        else:
            retval = self.run(node.value)
        raise ReturnValue(retval)

    def on_repr(self, node):
        """Repr."""
        return repr(self.run(node.value))

    def on_module(self, node):
        """Module def."""
        for n in node.body:
            self.retval = self.run(n)

    def on_expression(self, node):
        "basic expression"
        return self.run(node.body)

    def on_pass(self, node):
        """Pass statement."""
        return None

    def on_ellipsis(self, node):
        """Ellipses.  deprecated in 3.8"""
        return Ellipsis

    # for break and continue: set the instance variable _interrupt
    def on_interrupt(self, node):
        """Interrupt handler."""
        return

    def on_break(self, node):
        """Break."""
        self._interrupt = BreakInterrupt()
        return

    def on_continue(self, node):
        """Continue."""
        self._interrupt = ContinueInterrupt()
        return

    def on_assert(self, node):
        """Assert statement."""
        test = self.run(node.test)
        if not test:
            msg = 'Assertion Failed'
            if node.msg is not None:
                msg = self.run(node.msg)
            self.raise_exception(node, exc=AssertionError, msg=msg)

    def on_list(self, node):
        """List."""
        return [self.run(elt) for elt in node.elts]

    def on_tuple(self, node):
        """Tuple."""
        return tuple(self.run(elt) for elt in node.elts)

    def on_set(self, node):
        """Set."""
        return set(self.run(elt) for elt in node.elts)

    def on_dict(self, node):
        """Dictionary."""
        keys = [self.run(k) if k is not None else None for k in node.keys]
        vals = [self.run(v) for v in node.values]
        return dict(zip(keys, vals))

    def on_constant(self, node):
        """Return constant value."""
        return node.value

    def on_num(self, node):
        """Return number.  deprecated in 3.8"""
        return node.n

    def on_str(self, node):
        """Return string.  deprecated in 3.8"""
        return node.s

    def on_bytes(self, node):
        """return bytes.  deprecated in 3.8"""
        return node.s if hasattr(node, 's') else node.value

    def on_joinedstr(self, node):
        "join strings, used in f-strings"
        return ''.join(self.run(v) for v in node.values)

    def on_formattedvalue(self, node):
        "formatting used in f-strings"
        val = self.run(node.value)
        if node.conversion == -1:
            out = val
        elif node.conversion == ord('s'):
            out = str(val)
        elif node.conversion == ord('r'):
            out = repr(val)
        elif node.conversion == ord('a'):
            out = ascii(val)
        else:
            out = val
        if node.format_spec is not None:
            fmt = ''.join(self.run(v) for v in node.format_spec.values)
            out = format(out, fmt)
        elif node.conversion == -1:
            out = str(out)
        return out

    def _getsym(self, node):
        sym = node.id
        if sym in self.symtable:
            return self.symtable[sym]
        raise NameError(f"name '{sym}' is not defined")

    def on_name(self, node):
        """Name node."""
        return self._getsym(node)

    def on_nameconstant(self, node):
        """True, False, or None  deprecated in 3.8"""
        return node.value

    def node_assign(self, node, val):
        """Assign a value (not the node.value object) to a node.

        This is used by on_assign, but also by for, list comprehension,
        etc.

        """
        if isinstance(node, ast.Name):
            sym = node.id
            if sym in self.readonly_symbols:
                self.raise_exception(node, exc=AttributeError,
                                     msg=f"cannot assign to read-only symbol '{sym}'")
                return
            self.symtable[sym] = val
        elif isinstance(node, ast.Attribute):
            target = self.run(node.value)
            attr = node.attr
            try:
                setattr(target, attr, val)
            except Exception as e:
                self.raise_exception(node, exc=type(e), msg=str(e))
        elif isinstance(node, ast.Subscript):
            target = self.run(node.value)
            idx = self.run(node.slice)
            try:
                target[idx] = val
            except Exception as e:
                self.raise_exception(node, exc=type(e), msg=str(e))
        elif isinstance(node, ast.Tuple) or isinstance(node, ast.List):
            elts = node.elts
            if isinstance(val, (list, tuple)):
                for i, elt in enumerate(elts):
                    self.node_assign(elt, val[i])
            else:
                self.raise_exception(node, exc=TypeError,
                                     msg="cannot unpack non-iterable")
        else:
            self.raise_exception(node, exc=NotImplementedError,
                                 msg="assignment to this node type not supported")

    def on_attribute(self, node):
        """Extract attribute."""
        target = self.run(node.value)
        attr = node.attr
        if attr in UNSAFE_ATTRS:
            self.raise_exception(node, exc=AttributeError,
                                 msg=f"unsafe attribute '{attr}' not accessible")
            return None
        try:
            return getattr(target, attr)
        except AttributeError:
            self.raise_exception(node, exc=AttributeError,
                                 msg=f"'{type(target).__name__}' object has no attribute '{attr}'")
            raise

    def on_assign(self, node):
        """Simple assignment."""
        val = self.run(node.value)
        for t in node.targets:
            self.node_assign(t, val)
        return val

    def on_augassign(self, node):
        """Augmented assign."""
        opnode = node.op
        op = OPERATORS.get(type(opnode))
        if op is None:
            self.raise_exception(node, exc=NotImplementedError,
                                 msg="AugAssign with operator %s not supported" % type(opnode).__name__)
            return
        target = node.target
        if isinstance(target, ast.Name):
            sym = target.id
            if sym in self.readonly_symbols:
                self.raise_exception(node, exc=AttributeError,
                                     msg=f"cannot assign to read-only symbol '{sym}'")
                return
            try:
                oldval = self.symtable[sym]
            except KeyError:
                self.raise_exception(node, exc=NameError,
                                     msg=f"name '{sym}' is not defined")
                return
            newval = op(oldval, self.run(node.value))
            self.symtable[sym] = newval
            return newval
        elif isinstance(target, ast.Subscript):
            obj = self.run(target.value)
            idx = self.run(target.slice)
            try:
                newval = op(obj[idx], self.run(node.value))
                obj[idx] = newval
                return newval
            except Exception as e:
                self.raise_exception(node, exc=type(e), msg=str(e))
                raise
        else:
            self.raise_exception(node, exc=NotImplementedError,
                                 msg="AugAssign to this target not supported")
            return

    def on_slice(self, node):
        """Simple slice."""
        lower = self.run(node.lower) if node.lower is not None else None
        upper = self.run(node.upper) if node.upper is not None else None
        step = self.run(node.step) if node.step is not None else None
        return slice(lower, upper, step)

    def on_extslice(self, node):
        """Extended slice."""
        dims = tuple(self.run(d) for d in node.dims)
        return dims

    def on_subscript(self, node):
        """Subscript handling -- one of the tricky parts."""
        obj = self.run(node.value)
        sli = self.run(node.slice)
        try:
            return obj[sli]
        except Exception as e:
            self.raise_exception(node, exc=type(e), msg=str(e))
            raise

    def on_delete(self, node):
        """Delete statement."""
        for target in node.targets:
            if isinstance(target, ast.Name):
                sym = target.id
                if sym in self.readonly_symbols:
                    self.raise_exception(node, exc=AttributeError,
                                         msg=f"cannot delete read-only symbol '{sym}'")
                    return
                if sym in self.symtable:
                    del self.symtable[sym]
            elif isinstance(target, ast.Attribute):
                obj = self.run(target.value)
                try:
                    delattr(obj, target.attr)
                except Exception as e:
                    self.raise_exception(node, exc=type(e), msg=str(e))
            elif isinstance(target, ast.Subscript):
                obj = self.run(target.value)
                idx = self.run(target.slice)
                try:
                    del obj[idx]
                except Exception as e:
                    self.raise_exception(node, exc=type(e), msg=str(e))

    def on_unaryop(self, node):
        """Unary operator."""
        op = OPERATORS.get(type(node.op))
        if op is None:
            self.raise_exception(node, exc=NotImplementedError,
                                 msg=f"UnaryOp {type(node.op).__name__} not supported")
            return
        operand = self.run(node.operand)
        return op(operand)

    def on_binop(self, node):
        """Binary operator."""
        op = OPERATORS.get(type(node.op))
        if op is None:
            self.raise_exception(node, exc=NotImplementedError,
                                 msg=f"BinOp {type(node.op).__name__} not supported")
            return
        left = self.run(node.left)
        right = self.run(node.right)
        return op(left, right)

    def on_boolop(self, node):
        """Boolean operator."""
        op = OPERATORS.get(type(node.op))
        if op is None:
            self.raise_exception(node, exc=NotImplementedError,
                                 msg=f"BoolOp {type(node.op).__name__} not supported")
            return
        if isinstance(node.op, ast.And):
            # Short-circuit AND: evaluate one at a time, stop at first falsy
            result = self.run(node.values[0])
            if not result:
                return result
            for v in node.values[1:]:
                result = self.run(v)
                if not result:
                    return result
            return result
        elif isinstance(node.op, ast.Or):
            # Short-circuit OR: evaluate one at a time, stop at first truthy
            result = self.run(node.values[0])
            if result:
                return result
            for v in node.values[1:]:
                result = self.run(v)
                if result:
                    return result
            return result
        else:
            # For any other bool op, evaluate all and reduce pairwise
            vals = [self.run(v) for v in node.values]
            result = vals[0]
            for v in vals[1:]:
                result = op(result, v)
            return result

    def on_compare(self, node):
        """comparison operators, including chained comparisons (a<b<c)"""
        left = self.run(node.left)
        ops = node.ops
        comps = node.comparators
        if len(ops) == 1:
            op = OPERATORS.get(type(ops[0]))
            if op is None:
                self.raise_exception(node, exc=NotImplementedError,
                                     msg=f"Compare {type(ops[0]).__name__} not supported")
                return
            right = self.run(comps[0])
            return op(left, right)
        else:
            # chained comparison: a < b < c => (a < b) and (b < c)
            result = True
            for i, op in enumerate(ops):
                func = OPERATORS.get(type(op))
                if func is None:
                    self.raise_exception(node, exc=NotImplementedError,
                                         msg=f"Compare {type(op).__name__} not supported")
                    return
                right = self.run(comps[i])
                result = result and func(left, right)
                left = right
            return result

    def _printer(self, *out, **kws):
        """Generic print function."""
        sep = kws.get('sep', ' ')
        end = kws.get('end', '\n')
        stream = kws.get('file', None)
        to_print = sep.join(repr(o) if isinstance(o, (bytes,)) else str(o) for o in out)
        to_print += end
        if stream is not None:
            stream.write(to_print)
        else:
            self.writer.write(to_print)

    def on_if(self, node):
        """Regular if-then-else statement."""
        test = self.run(node.test)
        if test:
            for s in node.body:
                self.retval = self.run(s)
                if self._interrupt is not None:
                    return
        else:
            for s in node.orelse:
                self.retval = self.run(s)
                if self._interrupt is not None:
                    return

    def on_ifexp(self, node):
        """If expressions."""
        test = self.run(node.test)
        if test:
            return self.run(node.body)
        else:
            return self.run(node.orelse)

    def on_while(self, node):
        """While blocks."""
        did_break = False
        while True:
            self._interrupt = None
            test = self.run(node.test)
            if not test:
                break
            body_interrupt = None
            for s in node.body:
                self.retval = self.run(s)
                if self._interrupt is not None:
                    body_interrupt = self._interrupt
                    self._interrupt = None
                    break
            if body_interrupt is None:
                # body completed without break/continue, loop again
                continue
            elif isinstance(body_interrupt, BreakInterrupt):
                did_break = True
                break
            elif isinstance(body_interrupt, ContinueInterrupt):
                continue
            else:
                break
        else:
            pass
        if not did_break and node.orelse:
            for s in node.orelse:
                self.retval = self.run(s)

    def on_for(self, node):
        """For blocks."""
        it = self.run(node.iter)
        did_break = False
        for val in it:
            self._interrupt = None
            self.node_assign(node.target, val)
            body_interrupt = None
            for s in node.body:
                self.retval = self.run(s)
                if self._interrupt is not None:
                    body_interrupt = self._interrupt
                    self._interrupt = None
                    break
            if body_interrupt is None:
                continue
            elif isinstance(body_interrupt, BreakInterrupt):
                did_break = True
                break
            elif isinstance(body_interrupt, ContinueInterrupt):
                continue
            else:
                break
        if not did_break and node.orelse:
            for s in node.orelse:
                self.retval = self.run(s)

    def on_with(self, node):
        """with blocks."""
        items = node.items
        ctxs = []
        for item in items:
            ctx = self.run(item.context_expr)
            ctxs.append(ctx)
            if item.optional_vars is not None:
                self.node_assign(item.optional_vars, ctx)
        for s in node.body:
            self.retval = self.run(s)

    def comprehension_data(self, node):
        """Return comprehension data."""
        return node.generators

    def on_listcomp(self, node):
        """List comprehension v2"""
        def inner(gen, scope):
            it = self.run(gen.iter)
            for val in it:
                self.node_assign(gen.target, val)
                if all(self.run(ifilter) for ifilter in gen.ifs):
                    if gen.iter == node.generators[-1].iter:
                        yield self.run(node.elt)
                    else:
                        yield from inner(node.generators[-1], scope)
            return
        return list(inner(node.generators[0], {}))

    def on_setcomp(self, node):
        """Set comprehension"""
        result = []
        self._do_comp(node.generators, node.elt, result)
        return set(result)

    def on_dictcomp(self, node):
        """Dict comprehension v2"""
        result = {}
        self._do_comp(node.generators, (node.key, node.value), result)
        return result

    def _do_comp(self, generators, elt, result):
        if not generators:
            return
        gen = generators[0]
        rest = generators[1:]
        it = self.run(gen.iter)
        for val in it:
            self.node_assign(gen.target, val)
            if all(self.run(ifilter) for ifilter in gen.ifs):
                if not rest:
                    if isinstance(elt, tuple):
                        k, v = self.run(elt[0]), self.run(elt[1])
                        result[k] = v
                    else:
                        result.append(self.run(elt))
                else:
                    self._do_comp(rest, elt, result)

    def on_excepthandler(self, node):
        """Exception handler..."""
        return (self.run(node.type), node.name, node.body)

    def on_try(self, node):
        """Try/except/else/finally blocks."""
        exc_info = None
        did_except = False
        did_break = False
        body_interrupt = None
        try:
            for s in node.body:
                self.retval = self.run(s)
                if self._interrupt is not None:
                    body_interrupt = self._interrupt
                    self._interrupt = None
                    break
        except Exception as e:
            exc_info = e
            did_except = True
            for handler in node.handlers:
                exc_type = self.run(handler.type) if handler.type is not None else None
                if exc_type is None or isinstance(exc_info, exc_type):
                    if handler.name is not None:
                        self.symtable[handler.name] = exc_info
                    for s in handler.body:
                        self.retval = self.run(s)
                        if self._interrupt is not None:
                            body_interrupt = self._interrupt
                            self._interrupt = None
                            break
                    break
            else:
                raise exc_info

        if not did_except and body_interrupt is None and hasattr(node, 'orelse') and node.orelse:
            for s in node.orelse:
                self.retval = self.run(s)
                if self._interrupt is not None:
                    body_interrupt = self._interrupt
                    self._interrupt = None
                    break

        if hasattr(node, 'finalbody') and node.finalbody:
            for s in node.finalbody:
                self.retval = self.run(s)

        # Propagate interrupt out so enclosing for/while can see it
        if body_interrupt is not None:
            self._interrupt = body_interrupt

    def on_raise(self, node):
        """Raise statement: note difference for python 2 and 3."""
        if node.exc is not None:
            exc = self.run(node.exc)
            if isinstance(exc, type) and issubclass(exc, BaseException):
                raise exc()
            raise exc
        else:
            raise Exception("Reraise not supported")

    def on_call(self, node):
        """Function execution."""
        func = self.run(node.func)
        args = [self.run(arg) for arg in node.args]
        keywords = node.keywords
        kws = {}
        for kw in keywords:
            if hasattr(kw, 'arg'):  # Python 3.1+
                kws[kw.arg] = self.run(kw.value)
            else:
                kws[kw[0]] = self.run(kw[1])
        try:
            return func(*args, **kws)
        except Exception as e:
            self.raise_exception(node, exc=type(e), msg=str(e))
            raise

    def on_arg(self, node):
        """Arg for function definitions."""
        return node.arg

    def on_functiondef(self, node):
        """Define procedures."""
        # ('name', 'args', 'body', 'decorator_list')
        docstring = None
        if node.body and isinstance(node.body[0], ast.Expr):
            expr_node = node.body[0].value
            if isinstance(expr_node, ast.Constant) and isinstance(expr_node.value, str):
                docstring = expr_node.value

        args = []
        kwargs = []
        vararg = None
        varkws = None

        # positional args
        num_defaults = len(node.args.defaults)
        num_args = len(node.args.args)
        for i, arg in enumerate(node.args.args):
            if i < num_args - num_defaults:
                args.append(arg.arg)
            else:
                dflt_idx = i - (num_args - num_defaults)
                kwargs.append((arg.arg, node.args.defaults[dflt_idx]))

        # keyword-only args
        for i, arg in enumerate(node.args.kwonlyargs):
            if i < len(node.args.kw_defaults) and node.args.kw_defaults[i] is not None:
                kwargs.append((arg.arg, node.args.kw_defaults[i]))
            else:
                kwargs.append((arg.arg, None))

        if node.args.vararg is not None:
            vararg = node.args.vararg.arg
        if node.args.kwarg is not None:
            varkws = node.args.kwarg.arg

        proc = Procedure(name=node.name, interp=self,
                         doc=docstring, lineno=self.lineno,
                         body=node.body, args=args, kwargs=kwargs,
                         vararg=vararg, varkws=varkws)
        self.symtable[node.name] = proc
        return proc

    def _run_procedure(self, proc, *args, **kwargs):
        """Run a Procedure object's body in the interpreter."""
        # Build a set of all parameter names to know which globals to shadow
        param_names = set(proc.argnames)
        for kw_name, _ in proc.kwargs:
            param_names.add(kw_name)
        if proc.vararg is not None:
            param_names.add(proc.vararg)
        if proc.varkws is not None:
            param_names.add(proc.varkws)

        # Create a local symbol table starting from global, but shadow param names
        # so positional args don't get confused with outer scope values
        local_symtable = dict(self.symtable)

        used_args = list(args)
        used_kwargs = dict(kwargs)

        # Build a map from param name to its default AST node (or None)
        defaults = {}
        for kw_name, kw_dflt in proc.kwargs:
            defaults[kw_name] = kw_dflt

        # Build ordered parameter list: argnames first, then kwargs (for defaults)
        ordered_params = list(proc.argnames)
        for kw_name, _ in proc.kwargs:
            if kw_name not in ordered_params:
                ordered_params.append(kw_name)

        # First, consume explicit keyword args for non-argname params
        kw_assigned = set()
        for kw_name, _ in proc.kwargs:
            if kw_name in used_kwargs:
                local_symtable[kw_name] = used_kwargs.pop(kw_name)
                kw_assigned.add(kw_name)

        # Assign positional args to ordered parameters
        pos_idx = 0
        for name in ordered_params:
            if name in kw_assigned:
                continue  # already assigned from explicit keyword
            if pos_idx < len(used_args):
                local_symtable[name] = used_args[pos_idx]
                pos_idx += 1
            elif name in defaults:
                dflt = defaults[name]
                local_symtable[name] = self.run(dflt) if dflt is not None else None

        # Handle varargs - remaining positional args
        if proc.vararg is not None:
            local_symtable[proc.vararg] = tuple(used_args[pos_idx:])

        # Handle varkws - remaining keyword args
        if proc.varkws is not None:
            local_symtable[proc.varkws] = dict(used_kwargs)

        # Save the old symtable and swap in local one
        old_symtable = self.symtable
        self.symtable = local_symtable

        # Execute body
        self._calldepth += 1
        try:
            for stmt in proc.body:
                result = self.run(stmt)
                if self._interrupt is not None:
                    break
            self._calldepth -= 1
        except ReturnValue as rv:
            self._calldepth -= 1
            self.symtable = old_symtable
            return rv.value
        except Exception:
            self._calldepth -= 1
            self.symtable = old_symtable
            raise
        else:
            self.symtable = old_symtable


class BreakInterrupt(Exception):
    """Internal interrupt for break."""
    pass


class ContinueInterrupt(Exception):
    """Internal interrupt for continue."""
    pass


class ReturnValue(Exception):
    """Internal return value wrapper."""
    def __init__(self, value):
        self.value = value

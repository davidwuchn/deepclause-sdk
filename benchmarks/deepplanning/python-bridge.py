#!/usr/bin/env python3
"""
Bridge script that dispatches DeepPlanning tool calls.

Expects QWEN_AGENT_BENCH_DIR to point to the benchmark/deepplanning/ directory
inside the Qwen-Agent repo. If not set, looks for it relative to this script.

For travel tools, patches qwen_agent imports so they work without the full framework.
"""

import argparse
import json
import os
import sys


def _find_qwen_bench_dir():
    env_dir = os.environ.get('QWEN_AGENT_BENCH_DIR')
    if env_dir and os.path.isdir(env_dir):
        return env_dir
    candidates = [
        os.path.join(os.path.dirname(__file__), '..', 'vendor', 'Qwen-Agent', 'benchmark', 'deepplanning'),
        os.path.join(os.path.dirname(__file__), 'vendor', 'Qwen-Agent', 'benchmark', 'deepplanning'),
    ]
    for c in candidates:
        c = os.path.normpath(c)
        if os.path.isdir(c):
            return c
    return None


def _make_base_tool_shim():
    """Create a minimal BaseTool shim for travel tools that depend on qwen_agent.tools.base."""

    class BaseShoppingTool:
        name = ''
        description = ''
        parameters = {}

        def __init__(self, cfg=None):
            self.cfg = cfg or {}
            self.database_path = None
            self.data = None

        def _verify_json_format_args(self, params):
            if isinstance(params, str):
                import json as _json
                params = _json.loads(params)
            if isinstance(self.parameters, dict):
                for p in self.parameters.get('required', []):
                    if p not in params:
                        raise ValueError(f'Missing required argument: {p}')
            return params

        def load_json_database(self, path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)

        def load_csv_database(self, path):
            import pandas as pd
            return pd.read_csv(path, dtype=str)

        def format_result_as_json(self, result):
            return json.dumps(result, ensure_ascii=False, indent=2)

        def call(self, params, **kwargs):
            raise NotImplementedError

    GLOBAL_REGISTRY = {}

    def register_tool(name, **kwargs):
        def decorator(cls):
            cls.name = name
            GLOBAL_REGISTRY[name] = cls
            return cls
        return decorator

    return BaseShoppingTool, register_tool, GLOBAL_REGISTRY


def _patch_qwen_agent_imports():
    """Patch sys.modules so travel tools can import from qwen_agent.tools.base."""
    BaseTool, register_tool, registry = _make_base_tool_shim()

    qwen_agent = type(sys)('qwen_agent')
    qwen_tools = type(sys)('qwen_agent.tools')
    qwen_base = type(sys)('qwen_agent.tools.base')

    qwen_base.BaseTool = BaseTool
    qwen_base.register_tool = register_tool
    qwen_base.TOOL_REGISTRY = registry

    qwen_tools.base = qwen_base
    qwen_agent.tools = qwen_tools

    sys.modules['qwen_agent'] = qwen_agent
    sys.modules['qwen_agent.tools'] = qwen_tools
    sys.modules['qwen_agent.tools.base'] = qwen_base


def _get_tool_registry(bench_dir, domain):
    if domain == 'shopping':
        tools_dir = os.path.join(bench_dir, 'shoppingplanning', 'tools')
    elif domain == 'travel':
        _patch_qwen_agent_imports()
        tools_dir = os.path.join(bench_dir, 'travelplanning', 'tools')
    else:
        raise ValueError(f'Unknown domain: {domain}')

    if not os.path.isdir(tools_dir):
        raise FileNotFoundError(f'Tools directory not found: {tools_dir}')

    sys.path.insert(0, tools_dir)
    import importlib
    import glob as _glob

    if domain == 'shopping':
        import base_shopping_tool as _bst
        for py_file in sorted(_glob.glob(os.path.join(tools_dir, '*.py'))):
            mod_name = os.path.basename(py_file)[:-3]
            if mod_name.startswith('_') or mod_name == 'base_shopping_tool':
                continue
            try:
                importlib.import_module(mod_name)
            except Exception as e:
                print(f"Warning: could not import {mod_name}: {e}", file=sys.stderr)
        return _bst.TOOL_REGISTRY
    else:
        import base_travel_tool as _btt
        for py_file in sorted(_glob.glob(os.path.join(tools_dir, '*.py'))):
            mod_name = os.path.basename(py_file)[:-3]
            if mod_name.startswith('_') or mod_name == 'base_travel_tool':
                continue
            try:
                importlib.import_module(mod_name)
            except Exception as e:
                print(f"Warning: could not import {mod_name}: {e}", file=sys.stderr)
        return _btt.TOOL_REGISTRY


def main():
    parser = argparse.ArgumentParser(description='DeepPlanning tool bridge')
    parser.add_argument('--domain', required=True, choices=['travel', 'shopping'])
    parser.add_argument('--db-path', required=True, help='Per-task database directory')
    parser.add_argument('--tool', required=True, help='Tool name to invoke')
    parser.add_argument('--bench-dir', default=None, help='Path to Qwen-Agent benchmark/deepplanning dir')
    parser.add_argument('--args', default=None, help='JSON-encoded tool arguments')
    parser.add_argument('--args-file', default=None, help='Path to file containing JSON-encoded tool arguments')
    parser.add_argument('--args-stdin', action='store_true', help='Read JSON tool arguments from stdin')
    parser.add_argument('--kv', action='append', default=[], help='Key=value pair for tool arguments (repeatable)')
    parser.add_argument('--kv-file', default=None, help='Path to file with key=value lines for tool arguments')
    args = parser.parse_args()

    has_args = args.args or args.args_file or args.args_stdin or args.kv or args.kv_file
    if not has_args:
        print(json.dumps({'error': 'One of --args, --args-file, --args-stdin, --kv, or --kv-file is required'}))
        sys.exit(1)

    bench_dir = args.bench_dir or _find_qwen_bench_dir()
    if not bench_dir:
        print(json.dumps({'error': 'Cannot find Qwen-Agent benchmark directory. Set QWEN_AGENT_BENCH_DIR or clone Qwen-Agent repo.'}))
        sys.exit(1)

    registry = _get_tool_registry(bench_dir, args.domain)

    if args.tool not in registry:
        print(json.dumps({'error': f'Tool not found: {args.tool}. Available: {list(registry.keys())}'}))
        sys.exit(1)

    if args.kv_file:
        tool_args = {}
        if os.path.exists(args.kv_file) and os.path.getsize(args.kv_file) > 0:
            with open(args.kv_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.rstrip('\n')
                    if not line or line.startswith('#'):
                        continue
                    key, _, val = line.partition('=')
                    try:
                        tool_args[key] = json.loads(val)
                    except (json.JSONDecodeError, ValueError):
                        tool_args[key] = val
    elif args.kv:
        tool_args = {}
        for pair in args.kv:
            key, _, val = pair.partition('=')
            try:
                tool_args[key] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                tool_args[key] = val
    elif args.args_file:
        with open(args.args_file, 'r', encoding='utf-8') as f:
            tool_args = json.load(f)
    elif args.args_stdin:
        tool_args = json.load(sys.stdin)
    else:
        tool_args = json.loads(args.args)

    tool_cls = registry[args.tool]
    cfg = {'database_path': args.db_path, 'load_schema': True}
    if args.domain == 'travel':
        cfg['language'] = 'en'

    products_file = os.path.join(args.db_path, 'products.jsonl')
    if args.domain == 'shopping' and not os.path.exists(products_file):
        print(json.dumps({'error': f'Database file not found: {products_file}', 'db_path': args.db_path}), file=sys.stderr)
        if os.path.isdir(args.db_path):
            print(f"[bridge] dir contents: {os.listdir(args.db_path)}", file=sys.stderr)
        else:
            print(f"[bridge] db_path is NOT a directory: {args.db_path}", file=sys.stderr)
        sys.exit(1)

    tool_instance = tool_cls(cfg)

    if args.domain == 'shopping' and hasattr(tool_instance, 'bm25') and tool_instance.bm25 is None:
        products_file = os.path.join(args.db_path, 'products.jsonl')
        if not os.path.exists(products_file):
            print(json.dumps({'error': f'Database file not found: {products_file}', 'db_path': args.db_path}))
            sys.exit(1)
        if os.path.getsize(products_file) == 0:
            print(json.dumps({'error': f'Database file is empty: {products_file}'}))
            sys.exit(1)
        try:
            from rank_bm25 import BM25Okapi as _check
        except ImportError:
            print(json.dumps({'error': 'rank_bm25 package is not installed. Run: pip install rank-bm25'}))
            sys.exit(1)
        print(json.dumps({'error': f'BM25 index failed to build. db_path={args.db_path}, products_file={products_file}, file_exists={os.path.exists(products_file)}, file_size={os.path.getsize(products_file) if os.path.exists(products_file) else 0}'}))
        sys.exit(1)

    result = tool_instance.call(tool_args)
    sys.stdout.write(result)


if __name__ == '__main__':
    main()

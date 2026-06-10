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

    sys.path.insert(0, bench_dir)
    sys.path.insert(0, tools_dir)
    if domain == 'shopping':
        import shoppingplanning.tools as _pkg
        from shoppingplanning.tools.base_shopping_tool import TOOL_REGISTRY
        if not TOOL_REGISTRY:
            import shoppingplanning.tools.base_shopping_tool as _bst
            for name in dir(_bst):
                obj = getattr(_bst, name)
                if isinstance(obj, type) and hasattr(obj, 'call') and hasattr(obj, 'name') and obj.name:
                    TOOL_REGISTRY[obj.name] = obj
        if not TOOL_REGISTRY:
            import importlib
            for mod_name in ['search_products_tool', 'filter_by_brand_tool', 'filter_by_color_tool',
                             'filter_by_size_tool', 'filter_by_range_tool', 'sort_product_tool',
                             'get_product_details_tool', 'calculate_transport_time_tool',
                             'get_user_info', 'add_product_to_cart', 'delete_product_from_cart',
                             'get_cart_info', 'add_coupon_to_cart', 'delete_coupon_from_cart']:
                try:
                    importlib.import_module(f'shoppingplanning.tools.{mod_name}')
                except Exception as e:
                    print(f"Warning: could not import {mod_name}: {e}", file=sys.stderr)
        return TOOL_REGISTRY
    else:
        import travelplanning.tools as _pkg
        from travelplanning.tools.base_travel_tool import TOOL_REGISTRY
        if not TOOL_REGISTRY:
            import importlib
            import glob as _glob
            travel_tools_dir = os.path.join(bench_dir, 'travelplanning', 'tools')
            for py_file in _glob.glob(os.path.join(travel_tools_dir, '*.py')):
                mod_name = os.path.basename(py_file)[:-3]
                if mod_name.startswith('_'):
                    continue
                try:
                    importlib.import_module(f'travelplanning.tools.{mod_name}')
                except Exception as e:
                    print(f"Warning: could not import {mod_name}: {e}", file=sys.stderr)
        return TOOL_REGISTRY


def main():
    parser = argparse.ArgumentParser(description='DeepPlanning tool bridge')
    parser.add_argument('--domain', required=True, choices=['travel', 'shopping'])
    parser.add_argument('--db-path', required=True, help='Per-task database directory')
    parser.add_argument('--tool', required=True, help='Tool name to invoke')
    parser.add_argument('--bench-dir', default=None, help='Path to Qwen-Agent benchmark/deepplanning dir')
    parser.add_argument('--args', required=True, help='JSON-encoded tool arguments')
    args = parser.parse_args()

    bench_dir = args.bench_dir or _find_qwen_bench_dir()
    if not bench_dir:
        print(json.dumps({'error': 'Cannot find Qwen-Agent benchmark directory. Set QWEN_AGENT_BENCH_DIR or clone Qwen-Agent repo.'}))
        sys.exit(1)

    registry = _get_tool_registry(bench_dir, args.domain)

    if args.tool not in registry:
        print(json.dumps({'error': f'Tool not found: {args.tool}. Available: {list(registry.keys())}'}))
        sys.exit(1)

    tool_cls = registry[args.tool]
    cfg = {'database_path': args.db_path, 'load_schema': True}
    if args.domain == 'travel':
        cfg['language'] = 'en'

    tool_instance = tool_cls(cfg)
    tool_args = json.loads(args.args)
    result = tool_instance.call(tool_args)
    sys.stdout.write(result)


if __name__ == '__main__':
    main()

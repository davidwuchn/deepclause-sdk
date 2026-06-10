#!/usr/bin/env python3
"""
Bridge script that dispatches DeepPlanning tool calls.

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
                params = json.loads(params)
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

    import importlib
    import glob as _glob

    if domain == 'shopping':
        sys.path.insert(0, tools_dir)
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
        if bench_dir not in sys.path:
            sys.path.insert(0, bench_dir)

        travel_pkg = type(sys)('travelplanning')
        travel_pkg.__path__ = [os.path.join(bench_dir, 'travelplanning')]
        travel_pkg.__package__ = 'travelplanning'
        sys.modules['travelplanning'] = travel_pkg

        tools_pkg = type(sys)('travelplanning.tools')
        tools_pkg.__path__ = [tools_dir]
        tools_pkg.__package__ = 'travelplanning.tools'
        sys.modules['travelplanning.tools'] = tools_pkg

        from travelplanning.tools.base_travel_tool import TOOL_REGISTRY
        for py_file in sorted(_glob.glob(os.path.join(tools_dir, '*.py'))):
            mod_name = os.path.basename(py_file)[:-3]
            if mod_name.startswith('_') or mod_name == 'base_travel_tool':
                continue
            full_mod = f'travelplanning.tools.{mod_name}'
            try:
                importlib.import_module(full_mod)
            except Exception as e:
                print(f"Warning: could not import {full_mod}: {e}", file=sys.stderr)
        return TOOL_REGISTRY


TRAVEL_DB_MAPPING = {
    'query_train_info': 'trains/trains.csv',
    'query_flight_info': 'flights/flights.csv',
    'query_hotel_info': 'hotels/hotels.csv',
    'query_attraction_details': 'attractions/attractions.csv',
    'recommend_attractions': 'attractions/attractions.csv',
    'search_location': 'locations/locations_coords.csv',
    'query_road_route_info': 'transportation/distance_matrix.csv',
    'recommend_restaurants': 'restaurants/restaurants.csv',
    'query_restaurant_details': 'restaurants/restaurants.csv',
}


def main():
    parser = argparse.ArgumentParser(description='DeepPlanning tool bridge')
    parser.add_argument('--domain', required=True, choices=['travel', 'shopping'])
    parser.add_argument('--db-path', required=True, help='Per-task database directory')
    parser.add_argument('--tool', required=True, help='Tool name to invoke')
    parser.add_argument('--bench-dir', default=None, help='Path to Qwen-Agent benchmark/deepplanning dir')
    parser.add_argument('--args', default=None, help='JSON-encoded tool arguments')
    parser.add_argument('--args-file', default=None, help='Path to file containing JSON-encoded tool arguments')
    args = parser.parse_args()

    if not args.args and not args.args_file:
        tool_args = {}
    elif args.args_file:
        with open(args.args_file, 'r', encoding='utf-8') as f:
            tool_args = json.load(f)
    else:
        tool_args = json.loads(args.args)

    for key in list(tool_args.keys()):
        val = tool_args[key]
        if isinstance(val, str):
            try:
                parsed = json.loads(val)
                if isinstance(parsed, (list, dict)):
                    tool_args[key] = parsed
                elif isinstance(parsed, (int, float)) and not isinstance(parsed, bool):
                    if key.endswith('_id') or key.endswith('_name') or key.endswith('_ids'):
                        pass
                    else:
                        tool_args[key] = parsed
            except (json.JSONDecodeError, ValueError):
                pass

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
        db_file = TRAVEL_DB_MAPPING.get(args.tool)
        if db_file:
            cfg['database_path'] = os.path.join(args.db_path, db_file)

    tool_instance = tool_cls(cfg)
    result = tool_instance.call(tool_args)
    sys.stdout.write(result)


if __name__ == '__main__':
    main()

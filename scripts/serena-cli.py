# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["serena-agent==2.1.0"]
# ///
"""只读 Serena CLI：提供 definition、references、doc 三个符号查询命令。"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any

from serena.agent import SerenaAgent
from serena.config.serena_config import SerenaConfig
from serena.project import Project
from serena.symbol import LanguageServerSymbol, LanguageServerSymbolRetriever
from serena.util.text_utils import TextOutputUtils

DEFAULT_MAX_CHARS = 20_000
SERENA_VERSION = "2.1.0"
SNIPPET_LINE = re.compile(r"(?m)^([ \t]*(?:\.\.\.[ \t]*)?(?:>[ \t]*)?)(\d+)(:)")

# Serena JSON 由不同语言服务器动态生成。
JsonValue = Any


class CliError(Exception):
    """可向 CLI 用户展示的查询错误。"""


def positive_int(value: str) -> int:
    """解析正整数参数。"""
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("value must be a positive integer")
    return number


def build_parser() -> argparse.ArgumentParser:
    """构造三个只读查询命令的参数解析器。"""
    parser = argparse.ArgumentParser(prog="pnpm serena", description=__doc__)
    parser.add_argument("--version", action="version", version=f"serena-agent {SERENA_VERSION}")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("definition", "Find symbol definitions"),
        ("references", "Find symbol references"),
        ("doc", "Find symbol signatures and documentation"),
    ):
        command = commands.add_parser(name, help=help_text, description=help_text)
        command.add_argument("name_path", nargs="?", help="Serena symbol name path")
        command.add_argument("--at", metavar="FILE[:LINE]", help="Repository-relative file and 1-based line")
        command.add_argument("--max-chars", type=positive_int, default=DEFAULT_MAX_CHARS, help="Serena answer limit")
    return parser


def parse_at(value: str, parser: argparse.ArgumentParser) -> tuple[Path, int | None]:
    """解析 FILE[:LINE]，省略行号时表示只列出文件符号。"""
    file_text, separator, line_text = value.rpartition(":")
    if separator and line_text.isdigit():
        line = int(line_text)
        if line <= 0:
            parser.error("line must be a positive 1-based integer")
        return Path(file_text), line
    if separator and not line_text:
        parser.error("line must be a positive 1-based integer")
    return Path(value), None


def normalize_snippet(value: str) -> str:
    """把引用片段中的 0 起始行号转换为 1 起始。"""
    return SNIPPET_LINE.sub(lambda match: f"{match.group(1)}{int(match.group(2)) + 1}{match.group(3)}", value)


def normalize_json(value: JsonValue) -> JsonValue:
    """递归转换 Serena 输出中的行号字段。"""
    if isinstance(value, list):
        return [normalize_json(item) for item in value]
    if not isinstance(value, dict):
        return value
    result: dict[str, JsonValue] = {}
    for key, item in value.items():
        if key == "body_location" and isinstance(item, dict):
            result[key] = {
                part_key: part_value + 1
                if part_key in {"start_line", "end_line"} and isinstance(part_value, int)
                else normalize_json(part_value)
                for part_key, part_value in item.items()
            }
        elif key == "reference_line" and isinstance(item, int):
            result[key] = item + 1
        elif key == "content_around_reference" and isinstance(item, str):
            result[key] = normalize_snippet(item)
        else:
            result[key] = normalize_json(item)
    return result


def normalize_output(text: str) -> str:
    """保留可能的截断说明，规范化其后的 JSON 输出。"""
    for index, character in enumerate(text):
        if character not in "[{":
            continue
        try:
            data = json.loads(text[index:])
        except json.JSONDecodeError:
            continue
        compact = json.dumps(normalize_json(data), ensure_ascii=False, separators=(",", ":"))
        return text[:index] + compact
    return text


def symbol_candidates(symbols: list[LanguageServerSymbol]) -> str:
    """生成带 1 起始声明行的符号候选 JSON。"""
    data = [
        {
            "name_path": symbol.get_name_path(),
            "kind": symbol.symbol_kind_name,
            "relative_path": symbol.relative_path,
            "line": symbol.line + 1 if symbol.line is not None else None,
        }
        for symbol in symbols
    ]
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def document_symbols(agent: SerenaAgent, relative_path: str) -> list[LanguageServerSymbol]:
    """读取文件顶层符号，供候选与声明行定位共用。"""
    manager = agent.get_language_server_manager_or_raise()
    language_server = manager.get_language_server(relative_path)
    return [LanguageServerSymbol(item) for item in language_server.request_document_symbols(relative_path).iter_symbols()]


def file_candidates(agent: SerenaAgent, relative_path: str, max_chars: int) -> str:
    """返回文件顶层符号及位置，过长时降级为名称候选。"""
    symbols = document_symbols(agent, relative_path)
    full = symbol_candidates(symbols)

    def names() -> str:
        return json.dumps([symbol.get_name_path() for symbol in symbols], ensure_ascii=False)

    return TextOutputUtils.limit_length(full, max_chars, [names])


def resolve_unique_name(project: Project, name_path: str) -> LanguageServerSymbol:
    """全局解析引用目标，拒绝空结果和不唯一的名称。"""
    symbols = LanguageServerSymbolRetriever(project).find(name_path)
    exact = [symbol for symbol in symbols if symbol.get_name_path() == name_path]
    if len(exact) == 1:
        return exact[0]
    if len(symbols) == 1:
        return symbols[0]
    if not symbols:
        raise CliError(f"No symbol matches {name_path!r}")
    raise CliError(f"Multiple symbols match {name_path!r}; use --at or a full name path:\n{symbol_candidates(symbols)}")


def resolve_at_line(agent: SerenaAgent, relative_path: str, line: int) -> LanguageServerSymbol:
    """解析声明范围内起于指定行的符号。"""
    symbols = document_symbols(agent, relative_path)
    matches = []
    for symbol in symbols:
        selection = symbol.symbol_root.get("selectionRange", symbol.symbol_root["range"])
        if selection["start"]["line"] == line - 1:
            matches.append(symbol)
    if not matches:
        raise CliError(f"No symbol declared at {relative_path}:{line}")
    if len(matches) > 1:
        raise CliError(f"Multiple symbols declared at {relative_path}:{line}:\n{symbol_candidates(matches)}")
    return matches[0]


def apply_tool(agent: SerenaAgent, tool_name: str, *args: JsonValue, **kwargs: JsonValue) -> str:
    """执行一个官方只读工具并返回原始字符串结果。"""
    return agent.execute_task(lambda: agent.get_tool_by_name(tool_name).apply(*args, **kwargs), logged=False)


def run_query(agent: SerenaAgent, args: argparse.Namespace, relative_path: str | None, line: int | None) -> str:
    """按名称或位置分发定义、引用和文档查询。"""
    project = agent.get_active_project_or_raise()
    project.project_config.await_asynchronous_completion()
    if project.language_server_manager is None:
        project.create_language_server_manager()

    if relative_path is not None and line is None:
        return file_candidates(agent, relative_path, args.max_chars)

    name_path = args.name_path
    if relative_path is not None:
        assert line is not None
        symbol = resolve_at_line(agent, relative_path, line)
        name_path = symbol.get_name_path()
    elif args.command == "references":
        symbol = resolve_unique_name(project, name_path)
        relative_path = symbol.location.relative_path
        name_path = symbol.get_name_path()

    if args.command == "references":
        return apply_tool(
            agent,
            "find_referencing_symbols",
            name_path,
            relative_path,
            max_answer_chars=args.max_chars,
        )
    return apply_tool(
        agent,
        "find_symbol",
        name_path,
        relative_path=relative_path,
        include_info=args.command == "doc",
        max_answer_chars=args.max_chars,
    )


def main() -> int:
    """解析参数、运行独立 SerenaAgent 并输出紧凑 JSON。"""
    parser = build_parser()
    args = parser.parse_args()
    if bool(args.name_path) == bool(args.at):
        parser.error("exactly one of name_path or --at is required")

    root = Path.cwd().resolve()
    relative_path: str | None = None
    line: int | None = None
    if args.at:
        file_path, line = parse_at(args.at, parser)
        absolute_path = (root / file_path).resolve()
        if not absolute_path.is_relative_to(root) or not absolute_path.is_file():
            raise CliError(f"File is not inside the current project or does not exist: {file_path}")
        relative_path = absolute_path.relative_to(root).as_posix()

    config = SerenaConfig.from_config_file()
    config.web_dashboard = False
    config.gui_log_window = False
    config.log_level = logging.ERROR
    agent = SerenaAgent(project=str(root), serena_config=config)
    try:
        print(normalize_output(run_query(agent, args, relative_path, line)))
    finally:
        agent.on_shutdown()
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        raise SystemExit(main())
    except CliError as error:
        print(f"serena: error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as error:
        print(f"serena: error: {error}", file=sys.stderr)
        raise SystemExit(1) from None

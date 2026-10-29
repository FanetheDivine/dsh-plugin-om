# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["serena-agent==2.1.0"]
# ///
"""只读 Serena CLI：符号查询复用当前项目的常驻实例，也可使用单进程模式。"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import logging
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from serena.agent import SerenaAgent
    from serena.project import Project
    from serena.symbol import LanguageServerSymbol

DEFAULT_MAX_CHARS = 20_000
SERENA_VERSION = "2.1.0"
CLI_VERSION = "1"
DAEMON_IDLE_TIMEOUT = 900.0
DAEMON_REQUEST_TIMEOUT = 900.0
DAEMON_START_TIMEOUT = 120.0
DAEMON_STOP_TIMEOUT = 30.0
HEARTBEAT_TIMEOUT = 0.5
MAX_REQUEST_BYTES = 1_000_000
HTTP_READ_TIMEOUT = 10.0
SNIPPET_LINE = re.compile(r"(?m)^([ \t]*(?:\.\.\.[ \t]*)?(?:>[ \t]*)?)(\d+)(:)")
SCRIPT_PATH = Path(__file__).resolve()
QUERY_COMMANDS = {"definition", "references", "doc"}

# Serena JSON 由不同语言服务器动态生成。
JsonValue = Any


class CliError(Exception):
    """可向 CLI 用户展示的错误。"""


class DaemonUnavailable(Exception):
    """常驻实例无法启动或连接。"""


@dataclass(frozen=True)
class InstanceState:
    """一个项目实例的连接信息。"""

    root: str
    pid: int
    port: int
    token: str
    build: str


class InstanceLock:
    """使用实例文件锁串行化启动、重启和停止。"""

    def __init__(self, path: Path, timeout: float = DAEMON_START_TIMEOUT):
        self.path = path
        self.timeout = timeout
        self.fd: int | None = None

    def __enter__(self) -> InstanceLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        if os.fstat(self.fd).st_size == 0:
            os.write(self.fd, b"\0")
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                os.lseek(self.fd, 0, os.SEEK_SET)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.monotonic() >= deadline:
                    os.close(self.fd)
                    self.fd = None
                    raise DaemonUnavailable(f"timed out waiting for instance lock {self.path}") from None
                time.sleep(0.05)

    def __exit__(self, *_: object) -> None:
        if self.fd is None:
            return
        try:
            os.lseek(self.fd, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)
            self.fd = None


def script_build() -> str:
    """用脚本内容识别需要替换的旧实例。"""
    return f"{CLI_VERSION}-{hashlib.sha256(SCRIPT_PATH.read_bytes()).hexdigest()[:12]}"


def environment_timeout(name: str, default: float) -> float:
    """读取正数秒数环境变量。"""
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        timeout = float(value)
    except ValueError as error:
        raise CliError(f"{name} must be a number of seconds") from error
    if timeout <= 0:
        raise CliError(f"{name} must be greater than zero")
    return timeout


def state_directory() -> Path:
    """返回实例状态目录，测试可用环境变量隔离。"""
    configured = os.environ.get("SERENA_CLI_STATE_DIR")
    return Path(configured).expanduser().resolve() if configured else Path.home() / ".serena" / "serena-cli"


def instance_key(root: Path) -> str:
    """为规范化项目路径生成跨平台稳定键。"""
    normalized = os.path.normcase(str(root.resolve()))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]


def state_path(root: Path) -> Path:
    """返回项目实例状态文件。"""
    return state_directory() / f"{instance_key(root)}.json"


def lock_path(root: Path) -> Path:
    """返回项目实例锁文件。"""
    return state_directory() / f"{instance_key(root)}.lock"


def log_path(root: Path) -> Path:
    """返回项目实例日志文件。"""
    return state_directory() / f"{instance_key(root)}.log"


def read_state(path: Path) -> InstanceState | None:
    """读取完整状态，忽略损坏或字段不全的文件。"""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            return None
        if not all(isinstance(value.get(key), str) for key in ("root", "token", "build")):
            return None
        if not isinstance(value.get("pid"), int) or not isinstance(value.get("port"), int):
            return None
        return InstanceState(
            root=value["root"],
            pid=value["pid"],
            port=value["port"],
            token=value["token"],
            build=value["build"],
        )
    except (OSError, ValueError, TypeError):
        return None


def write_state(path: Path, state: InstanceState) -> None:
    """原子写入仅当前用户使用的实例状态。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(state.__dict__, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def remove_state(path: Path, expected_pid: int | None = None) -> None:
    """删除状态；指定 PID 时不删除其他实例的新状态。"""
    if expected_pid is not None:
        current = read_state(path)
        if current is not None and current.pid != expected_pid:
            return
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def positive_int(value: str) -> int:
    """解析正整数参数。"""
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("value must be a positive integer")
    return number


def build_parser() -> argparse.ArgumentParser:
    """构造只读查询与实例管理命令。"""
    parser = argparse.ArgumentParser(prog="pnpm serena", description=__doc__)
    parser.add_argument("--version", action="version", version=f"serena-agent {SERENA_VERSION}")
    parser.add_argument("--no-daemon", action="store_true", help="Run the query in a single process")
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
    commands.add_parser("status", help="Show the current project instance status")
    commands.add_parser("stop", help="Stop the current project instance")
    serve = commands.add_parser("_serve", help=argparse.SUPPRESS)
    serve.add_argument("--root", required=True, help=argparse.SUPPRESS)
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
    from serena.symbol import LanguageServerSymbol

    manager = agent.get_language_server_manager_or_raise()
    language_server = manager.get_language_server(relative_path)
    return [LanguageServerSymbol(item) for item in language_server.request_document_symbols(relative_path).iter_symbols()]


def file_candidates(agent: SerenaAgent, relative_path: str, max_chars: int) -> str:
    """返回文件顶层符号及位置，过长时降级为名称候选。"""
    from serena.util.text_utils import TextOutputUtils

    symbols = document_symbols(agent, relative_path)
    full = symbol_candidates(symbols)

    def names() -> str:
        return json.dumps([symbol.get_name_path() for symbol in symbols], ensure_ascii=False)

    return TextOutputUtils.limit_length(full, max_chars, [names])


def resolve_unique_name(project: Project, name_path: str) -> LanguageServerSymbol:
    """全局解析引用目标，拒绝空结果和不唯一的名称。"""
    from serena.symbol import LanguageServerSymbolRetriever

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


def create_agent(root: Path) -> SerenaAgent:
    """创建无界面的 Serena agent。"""
    from serena.agent import SerenaAgent
    from serena.config.serena_config import SerenaConfig

    config = SerenaConfig.from_config_file()
    config.web_dashboard = False
    config.gui_log_window = False
    config.log_level = logging.ERROR
    return SerenaAgent(project=str(root), serena_config=config)


def run_in_process(root: Path, request: dict[str, JsonValue]) -> str:
    """在单进程中执行一次查询并释放语言服务器。"""
    agent = create_agent(root)
    try:
        args = argparse.Namespace(
            command=request["command"], name_path=request["name_path"], max_chars=request["max_chars"]
        )
        return run_query(agent, args, request["relative_path"], request["line"])
    finally:
        agent.on_shutdown()


def daemon_request(
    state: InstanceState,
    method: str,
    route: str,
    payload: dict[str, JsonValue] | None = None,
    timeout: float = DAEMON_REQUEST_TIMEOUT,
) -> dict[str, JsonValue]:
    """直连本机实例并解析 JSON 响应。"""
    connection = http.client.HTTPConnection("127.0.0.1", state.port, timeout=timeout)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    headers = {"Authorization": f"Bearer {state.token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))
    try:
        connection.request(method, route, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise DaemonUnavailable("instance response is too large")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise DaemonUnavailable("instance returned a non-object response")
        if response.status >= 400:
            raise CliError(str(value.get("error", f"instance returned HTTP {response.status}")))
        return value
    except (OSError, TimeoutError, UnicodeError, json.JSONDecodeError) as error:
        raise DaemonUnavailable(str(error)) from error
    finally:
        connection.close()


def heartbeat(state: InstanceState, timeout: float = HEARTBEAT_TIMEOUT) -> dict[str, JsonValue] | None:
    """读取实例心跳，连接或鉴权失败时视为不可用。"""
    try:
        value = daemon_request(state, "GET", "/heartbeat", timeout=timeout)
    except (CliError, DaemonUnavailable):
        return None
    return value if value.get("status") == "ok" and value.get("pid") == state.pid else None


def process_alive(pid: int) -> bool:
    """只读检查进程存活；Windows 不使用具有终止语义的 os.kill。"""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def wait_for_removal(path: Path, pid: int) -> None:
    """等待旧实例清理 agent、移除状态并退出进程。"""
    deadline = time.monotonic() + DAEMON_STOP_TIMEOUT
    while time.monotonic() < deadline:
        current = read_state(path)
        if (current is None or current.pid != pid) and not process_alive(pid):
            return
        time.sleep(0.1)
    raise DaemonUnavailable(f"instance {pid} did not stop within {DAEMON_STOP_TIMEOUT:g}s")


def shutdown_instance(path: Path, state: InstanceState) -> None:
    """请求实例优雅退出；存活实例在资源清理完成前不得删除状态。"""
    responsive = heartbeat(state) is not None
    if not responsive and not process_alive(state.pid):
        remove_state(path, state.pid)
        return
    if responsive:
        daemon_request(state, "POST", "/shutdown", payload={}, timeout=5.0)
    wait_for_removal(path, state.pid)


def daemon_executable() -> str:
    """Windows 使用无控制台解释器，其他平台沿用当前 Python。"""
    if os.name == "nt":
        pythonw = Path(sys.executable).with_name("pythonw.exe")
        if pythonw.is_file():
            return str(pythonw)
    return sys.executable


def spawn_daemon(root: Path, path: Path) -> subprocess.Popen[bytes]:
    """在项目外启动无窗口、分离的本机实例进程。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path(root).open("ab", buffering=0)
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    options: dict[str, Any] = {}
    if os.name == "nt":
        options["creationflags"] = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        )
    else:
        options["start_new_session"] = True
    try:
        return subprocess.Popen(
            [daemon_executable(), str(SCRIPT_PATH), "_serve", "--root", str(root)],
            cwd=Path.home(),
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env=environment,
            close_fds=True,
            **options,
        )
    finally:
        log_file.close()


def cancel_spawn(process: subprocess.Popen[bytes], path: Path) -> None:
    """清理启动失败的启动器、实际 daemon 和状态文件。"""
    current = read_state(path)
    if current is not None and current.pid != process.pid:
        try:
            os.kill(current.pid, signal.SIGTERM)
        except OSError:
            pass
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()
    remove_state(path)


def ensure_daemon(root: Path) -> InstanceState:
    """返回当前脚本的可用实例，必要时安全启动或替换。"""
    path = state_path(root)
    build = script_build()
    timeout = environment_timeout("SERENA_CLI_START_TIMEOUT", DAEMON_START_TIMEOUT)
    with InstanceLock(lock_path(root), timeout=max(timeout, 1.0)):
        current = read_state(path)
        if current is not None:
            responsive = heartbeat(current) is not None
            if responsive and current.build == build and Path(current.root) == root:
                return current
            if not responsive and not process_alive(current.pid):
                remove_state(path, current.pid)
            else:
                try:
                    shutdown_instance(path, current)
                except DaemonUnavailable as error:
                    raise CliError(f"existing instance {current.pid} is still running: {error}") from error
        remove_state(path)
        process = spawn_daemon(root, path)
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                current = read_state(path)
                # Windows venv 启动器与实际 Python 进程的 PID 不同。
                if current is not None and current.build == build and Path(current.root) == root:
                    if heartbeat(current) is not None:
                        return current
                if process.poll() is not None:
                    break
                time.sleep(0.05)
        except Exception:
            cancel_spawn(process, path)
            raise
        cancel_spawn(process, path)
        raise DaemonUnavailable(f"instance failed to start within {timeout:g}s; see {log_path(root)}")


class ProjectDaemon:
    """持有单个项目 agent，并串行执行查询。"""

    def __init__(self, root: Path):
        self.root = root
        self.agent: SerenaAgent | None = None
        self.query_lock = threading.Lock()
        self.activity = threading.Condition()
        self.in_flight = 0
        self.last_activity = time.monotonic()
        self.stopping = threading.Event()

    @contextmanager
    def request(self):
        """记录请求活动，防止长查询和排队请求被误判为空闲。"""
        with self.activity:
            self.in_flight += 1
            self.last_activity = time.monotonic()
        try:
            yield
        finally:
            with self.activity:
                self.in_flight -= 1
                self.last_activity = time.monotonic()
                self.activity.notify_all()

    def idle_expired(self, timeout: float) -> bool:
        """仅在没有接收或执行中的请求时判断空闲超时。"""
        with self.activity:
            return self.in_flight == 0 and time.monotonic() - self.last_activity >= timeout

    def query(self, payload: dict[str, JsonValue]) -> str:
        """校验请求并在项目锁内执行查询。"""
        if self.stopping.is_set():
            raise CliError("instance is stopping")
        args, relative_path, line = validate_query(self.root, payload)
        with self.query_lock:
            if self.stopping.is_set():
                raise CliError("instance is stopping")
            if not self.root.is_dir():
                raise CliError(f"project directory no longer exists: {self.root}")
            if self.agent is None:
                self.agent = create_agent(self.root)
            return run_query(self.agent, args, relative_path, line)

    def close(self) -> None:
        """等待查询结束后释放项目 agent。"""
        self.stopping.set()
        with self.query_lock:
            if self.agent is not None:
                try:
                    self.agent.on_shutdown()
                finally:
                    self.agent = None


def validate_query(root: Path, payload: dict[str, JsonValue]) -> tuple[argparse.Namespace, str | None, int | None]:
    """校验来自本机客户端的查询字段和项目内路径。"""
    command = payload.get("command")
    name_path = payload.get("name_path")
    relative_path = payload.get("relative_path")
    line = payload.get("line")
    max_chars = payload.get("max_chars")
    if command not in QUERY_COMMANDS:
        raise CliError("invalid query command")
    if name_path is not None and not isinstance(name_path, str):
        raise CliError("name_path must be a string")
    if not name_path:
        name_path = None
    if relative_path is not None and not isinstance(relative_path, str):
        raise CliError("relative_path must be a string")
    if bool(name_path) == bool(relative_path):
        raise CliError("exactly one of name_path or relative_path is required")
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or max_chars <= 0:
        raise CliError("max_chars must be a positive integer")
    if line is not None and (isinstance(line, bool) or not isinstance(line, int) or line <= 0):
        raise CliError("line must be a positive integer")
    if relative_path is not None:
        absolute = (root / relative_path).resolve()
        if not absolute.is_relative_to(root) or not absolute.is_file():
            raise CliError("query file is not inside the current project or does not exist")
        relative_path = absolute.relative_to(root).as_posix()
    args = argparse.Namespace(command=command, name_path=name_path, max_chars=max_chars)
    return args, relative_path, line


class DaemonServer(ThreadingHTTPServer):
    """仅绑定回环地址的单项目 HTTP 服务。"""

    daemon_threads = False
    allow_reuse_address = False

    def __init__(self, root: Path, path: Path):
        self.root = root
        self.path = path
        self.project = ProjectDaemon(root)
        self.started = time.monotonic()
        self.build = script_build()
        self.token = secrets.token_urlsafe(32)
        super().__init__(("127.0.0.1", 0), DaemonHandler)

    @property
    def port(self) -> int:
        """返回操作系统分配的端口。"""
        return int(self.server_address[1])

    def state(self) -> InstanceState:
        """生成客户端连接状态。"""
        return InstanceState(str(self.root), os.getpid(), self.port, self.token, self.build)

    def request_shutdown(self) -> None:
        """拒绝新查询并从独立线程停止服务循环。"""
        if self.project.stopping.is_set():
            return
        self.project.stopping.set()
        threading.Thread(target=self.shutdown, daemon=True).start()


class DaemonHandler(BaseHTTPRequestHandler):
    """鉴权并分发实例管理与查询请求。"""

    server: DaemonServer
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        """限制不完整请求头和正文的等待时间。"""
        super().setup()
        self.connection.settimeout(HTTP_READ_TIMEOUT)

    def log_message(self, *_: object) -> None:
        """实例访问日志不写令牌或查询内容。"""

    def send_json(self, status: int, value: dict[str, JsonValue]) -> None:
        """发送短 JSON 响应。"""
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def authorized(self, post: bool = False) -> bool:
        """校验回环 Host、同源 Origin、Bearer token 和 JSON 类型。"""
        expected_origin = f"http://127.0.0.1:{self.server.port}"
        if self.headers.get("Host") != f"127.0.0.1:{self.server.port}":
            self.send_json(403, {"error": "invalid Host header"})
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin != expected_origin:
            self.send_json(403, {"error": "cross-origin requests are not allowed"})
            return False
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.token}"
        if not secrets.compare_digest(authorization, expected):
            self.send_json(401, {"error": "valid Bearer token required"})
            return False
        if post and self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self.send_json(415, {"error": "Content-Type must be application/json"})
            return False
        return True

    def read_payload(self) -> dict[str, JsonValue] | None:
        """读取有大小限制的 JSON 对象。"""
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(400, {"error": "valid Content-Length required"})
            return None
        if length < 0 or length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "request body is too large"})
            return None
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except TimeoutError:
            self.send_json(408, {"error": "request body timed out"})
            return None
        except (UnicodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "malformed JSON request"})
            return None
        if not isinstance(value, dict):
            self.send_json(400, {"error": "JSON request must be an object"})
            return None
        return value

    def do_GET(self) -> None:
        """提供鉴权心跳。"""
        if not self.authorized():
            return
        if self.path != "/heartbeat":
            self.send_json(404, {"error": "not found"})
            return
        self.send_json(
            200,
            {
                "status": "ok",
                "pid": os.getpid(),
                "build": self.server.build,
                "root": str(self.server.root),
                "uptime": round(time.monotonic() - self.server.started, 3),
            },
        )

    def do_POST(self) -> None:
        """跟踪完整请求周期，退出前必须交付已接收的响应。"""
        with self.server.project.request():
            if not self.authorized(post=True):
                return
            if self.path not in {"/query", "/shutdown"}:
                self.send_json(404, {"error": "not found"})
                return
            payload = self.read_payload()
            if payload is None:
                return
            if self.path == "/shutdown":
                self.send_json(200, {"ok": True})
                self.server.request_shutdown()
                return
            try:
                output = self.server.project.query(payload)
                self.send_json(200, {"ok": True, "output": output})
            except CliError as error:
                self.send_json(400, {"ok": False, "error": str(error)})
            except Exception as error:
                logging.exception("Serena query failed")
                self.send_json(500, {"ok": False, "error": str(error)})


def serve(root: Path) -> None:
    """运行项目实例直至停止、空闲超时或项目目录消失。"""
    root = root.resolve()
    if not root.is_dir():
        raise CliError(f"project directory does not exist: {root}")
    path = state_path(root)
    server = DaemonServer(root, path)
    idle_timeout = environment_timeout("SERENA_CLI_IDLE_TIMEOUT", DAEMON_IDLE_TIMEOUT)

    def watchdog() -> None:
        interval = min(1.0, max(0.05, idle_timeout / 4))
        while not server.project.stopping.wait(interval):
            if not root.is_dir() or server.project.idle_expired(idle_timeout):
                server.request_shutdown()
                return

    try:
        write_state(path, server.state())
        threading.Thread(target=watchdog, daemon=True).start()
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        server.project.close()
        remove_state(path, os.getpid())


def print_status(root: Path) -> None:
    """输出不含令牌和端口的实例状态。"""
    current = read_state(state_path(root))
    value = heartbeat(current) if current is not None else None
    if current is not None and value is None and process_alive(current.pid):
        print(
            json.dumps(
                {"status": "stopping", "root": str(root), "pid": current.pid, "build": current.build},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return
    if current is None or value is None:
        print(json.dumps({"status": "stopped"}, separators=(",", ":")))
        return
    print(
        json.dumps(
            {
                "status": "running",
                "root": str(root),
                "pid": current.pid,
                "build": current.build,
                "uptime": value["uptime"],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def stop_daemon(root: Path) -> None:
    """停止当前项目实例；没有实例时也成功。"""
    path = state_path(root)
    with InstanceLock(lock_path(root), timeout=DAEMON_STOP_TIMEOUT):
        current = read_state(path)
        if current is not None:
            try:
                shutdown_instance(path, current)
            except DaemonUnavailable as error:
                raise CliError(str(error)) from error
            remove_state(path, current.pid)
    print(json.dumps({"status": "stopped"}, separators=(",", ":")))


def run_with_daemon(root: Path, request: dict[str, JsonValue]) -> str:
    """优先使用项目实例，启动或连接失败时回退单进程。"""
    try:
        state = ensure_daemon(root)
    except (DaemonUnavailable, OSError) as error:
        print(f"serena: daemon unavailable: {error}; using single process", file=sys.stderr)
        return run_in_process(root, request)
    try:
        response = daemon_request(state, "POST", "/query", payload=request)
        if response.get("ok") is not True or not isinstance(response.get("output"), str):
            raise DaemonUnavailable("instance returned an invalid query response")
        return response["output"]
    except (DaemonUnavailable, http.client.HTTPException) as error:
        raise CliError(f"query response unavailable; query was not repeated: {error}") from error


def main() -> int:
    """解析命令并执行查询或实例管理。"""
    parser = build_parser()
    args = parser.parse_args()
    root = Path.cwd().resolve()
    if args.command == "_serve":
        serve(Path(args.root))
        return 0
    if args.command == "status":
        print_status(root)
        return 0
    if args.command == "stop":
        stop_daemon(root)
        return 0
    if bool(args.name_path) == bool(args.at):
        parser.error("exactly one of name_path or --at is required")

    relative_path: str | None = None
    line: int | None = None
    if args.at:
        file_path, line = parse_at(args.at, parser)
        absolute_path = (root / file_path).resolve()
        if not absolute_path.is_relative_to(root) or not absolute_path.is_file():
            raise CliError(f"File is not inside the current project or does not exist: {file_path}")
        relative_path = absolute_path.relative_to(root).as_posix()
    request: dict[str, JsonValue] = {
        "command": args.command,
        "name_path": args.name_path,
        "relative_path": relative_path,
        "line": line,
        "max_chars": args.max_chars,
    }
    if args.no_daemon or os.environ.get("SERENA_CLI_DAEMON") == "0":
        output = run_in_process(root, request)
    else:
        output = run_with_daemon(root, request)
    print(normalize_output(output))
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

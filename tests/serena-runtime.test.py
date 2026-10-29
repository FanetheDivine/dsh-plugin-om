# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["psutil==7.0.0"]
# ///
"""Serena CLI 的标准库行为测试：传输失败不重复执行，启动失败可回退。"""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "serena-cli.py"
SPEC = importlib.util.spec_from_file_location("serena_cli_under_test", SCRIPT)
CLI = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CLI
SPEC.loader.exec_module(CLI)


class RuntimeTests(unittest.TestCase):
    """无需语言服务器验证客户端错误边界。"""

    def test_submitted_query_failure_is_not_replayed(self):
        with patch.object(CLI, "ensure_daemon", return_value=Mock()), patch.object(
            CLI, "daemon_request", side_effect=CLI.DaemonUnavailable("response lost")
        ), patch.object(CLI, "run_in_process") as local:
            with self.assertRaises(CLI.CliError):
                CLI.run_with_daemon(Path.cwd(), {})
            local.assert_not_called()

    def test_startup_failure_falls_back_once(self):
        with patch.object(CLI, "ensure_daemon", side_effect=OSError("cannot open state")), patch.object(
            CLI, "run_in_process", return_value="[]"
        ) as local:
            self.assertEqual(CLI.run_with_daemon(Path.cwd(), {}), "[]")
            local.assert_called_once()


class QueryPreparationTests(unittest.TestCase):
    """初始化屏障、崩溃失败和路径规范化。"""

    def test_activation_barrier_prevents_second_manager(self):
        manager = Mock(_language_servers={})
        project = Mock(language_server_manager=None)
        agent = Mock(get_active_project_or_raise=Mock(return_value=project))
        agent.execute_task.side_effect = lambda *a, **k: setattr(project, "language_server_manager", manager)
        with patch.object(CLI, "file_candidates", return_value="[]"):
            self.assertEqual(CLI.run_query(agent, Mock(max_chars=100), "a.ts", None), "[]")
        agent.execute_task.assert_called_once()
        project.create_language_server_manager.assert_not_called()
        project.ls_sync_file_system_changes.assert_called_once()

    def test_failed_initialization_is_not_hidden_by_reinitialization(self):
        agent = Mock(get_active_project_or_raise=Mock(return_value=Mock(language_server_manager=None)))
        with self.assertRaises(CLI.CliError):
            CLI.run_query(agent, Mock(max_chars=100), "a.ts", None)
        agent.get_active_project_or_raise().create_language_server_manager.assert_not_called()

    def test_crashed_server_is_an_error(self):
        server = Mock(is_running=Mock(return_value=False))
        project = Mock(language_server_manager=Mock(_language_servers={"typescript": server}))
        agent = Mock(get_active_project_or_raise=Mock(return_value=project))
        with self.assertRaises(CLI.CliError):
            CLI.run_query(agent, Mock(max_chars=100), "a.ts", None)
        project.ls_sync_file_system_changes.assert_not_called()

    def test_paths_and_lines_are_normalized(self):
        value = {"src\\use.ts": [{"relative_path": "src\\use.ts", "reference_line": 0}]}
        self.assertEqual(CLI.normalize_json(value), {"src/use.ts": [{"relative_path": "src/use.ts", "reference_line": 1}]})


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--probe":
        import json
        import psutil

        processes = psutil.Process(int(sys.argv[2])).children(recursive=True)
        servers = []
        for process in processes:
            try:
                command = process.cmdline()
                if process.name().lower() in {"node", "node.exe"} and any("typescript-language-server" in arg for arg in command):
                    servers.append(process.pid)
            except psutil.Error:
                pass
        print(json.dumps({"typescript_servers": servers, "children": [p.pid for p in processes]}))
    else:
        unittest.main()

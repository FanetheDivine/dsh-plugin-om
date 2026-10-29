# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = []
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


if __name__ == "__main__":
    unittest.main()

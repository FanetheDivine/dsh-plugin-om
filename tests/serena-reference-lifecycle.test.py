# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["serena-agent==2.1.0"]
# ///
"""真实 LS 生命周期探针：重复引用不积累缓冲区，关闭工作区释放锚点。"""

import argparse
import importlib.util
import json
import sys
import threading
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("serena_reference_test", ROOT / "scripts" / "serena-cli.py")
CLI = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CLI
SPEC.loader.exec_module(CLI)


def buffers(agent):
    """收集真实语言服务器当前持有的文件。"""
    manager = agent.get_active_project_or_raise().get_language_server_manager_or_raise()
    return sorted(str(buffer.abs_path) for server in manager._language_servers.values()
                  for buffer in server.open_file_buffers.values())


def main():
    agent = CLI.create_agent(ROOT)
    workspace = None
    try:
        from solidlsp.language_servers.typescript_language_server import TypeScriptLanguageServer

        cold = object.__new__(TypeScriptLanguageServer)
        cold.server_ready = threading.Event()
        cold._custom_settings = {"server_ready_timeout": 0.001}
        try:
            cold._wait_for_server_ready()
        except CLI.CliError:
            pass
        else:
            raise AssertionError("TypeScript server-ready timeout was silently accepted")
        CLI.prepare_query(agent)
        before = buffers(agent)
        workspace = CLI.ReferenceWorkspace(agent)
        snapshots = []
        for name in ["buildTable", "planArchive", "safeJson"] * 2:
            args = argparse.Namespace(command="references", name_path=name, max_chars=20_000)
            CLI.run_query(agent, args, None, None, workspace)
            snapshot = buffers(agent)
            if any(path.endswith((".mjs", ".cjs")) for path in snapshot):
                raise AssertionError(f"temporary JS candidate retained: {snapshot}")
            snapshots.append(snapshot)
        if any(snapshot != snapshots[0] for snapshot in snapshots):
            raise AssertionError("repeated references changed persistent buffers")
        workspace.close()
        after = buffers(agent)
        if after != before:
            raise AssertionError(f"workspace leaked buffers: {before} -> {after}")
        print(json.dumps({"persistent_buffers": len(snapshots[0]), "before": len(before), "after": len(after)}))
    finally:
        try:
            if workspace is not None:
                workspace.close()
        finally:
            agent.on_shutdown()


if __name__ == "__main__":
    main()

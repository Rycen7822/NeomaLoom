import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "hermes-plugin" / "noemaloom"))

import noemaloom_bridge
from noemaloom_bridge import (
    _contains_timeout,
    _copy_runtime_migrations,
    _default_build_dir,
    _format_exception,
    _runtime_metadata,
    _runtime_migrations_ready,
    _source_mtime,
    _timeout_envelope,
)


def test_bridge_formats_nested_exception_groups():
    nested = ExceptionGroup("outer", [RuntimeError("inner boom"), ValueError("bad value")])

    message = _format_exception(nested)

    assert "ExceptionGroup: outer" in message
    assert "RuntimeError: inner boom" in message
    assert "ValueError: bad value" in message


def test_bridge_detects_nested_timeout_exception_groups():
    nested = ExceptionGroup("outer", [RuntimeError("inner"), TimeoutError("late tool")])

    assert _contains_timeout(nested) is True


def test_bridge_timeout_envelope_is_structured():
    envelope = json.loads(_timeout_envelope("nl_prepare_context", 1.5, project_root="/tmp/project"))

    assert envelope["ok"] is False
    assert envelope["tool"] == "nl_prepare_context"
    assert envelope["graphState"] == "error"
    assert envelope["warnings"][0]["code"] == "noemaloom_tool_timeout"
    assert "1.5s" in envelope["warnings"][0]["message"]


def test_bridge_reports_installed_metadata_mismatch(tmp_path, monkeypatch):
    plugin_file = tmp_path / "noemaloom_bridge.py"
    plugin_file.write_text("", encoding="utf-8")
    (tmp_path / "INSTALL_METADATA.json").write_text(
        json.dumps({"commit": "old-head", "dirtyFiles": 4}),
        encoding="utf-8",
    )
    monkeypatch.setattr(noemaloom_bridge, "__file__", str(plugin_file))
    monkeypatch.setattr(noemaloom_bridge, "_git_head", lambda repo: "new-head")
    monkeypatch.setattr(noemaloom_bridge, "_git_dirty_count", lambda repo: 0)

    warnings = noemaloom_bridge._provenance_warnings(Path("/tmp/source"))

    assert {warning["code"] for warning in warnings} == {
        "installed_plugin_source_mismatch",
        "installed_plugin_dirty_count_mismatch",
    }


def test_bridge_copy_install_builds_under_plugin_root(tmp_path, monkeypatch):
    plugin_root = tmp_path / "plugin"
    plugin_root.mkdir()
    plugin_file = plugin_root / "noemaloom_bridge.py"
    plugin_file.write_text("", encoding="utf-8")
    (plugin_root / "INSTALL_METADATA.json").write_text(json.dumps({"installMode": "copy", "commit": "abc"}), encoding="utf-8")
    monkeypatch.setattr(noemaloom_bridge, "__file__", str(plugin_file))

    build_dir = _default_build_dir(Path("/tmp/source"))
    runtime = _runtime_metadata(Path("/tmp/source"), build_dir)

    assert build_dir == plugin_root / ".noemaloom-hermes-build"
    assert runtime["buildRootInsidePlugin"] is True


def test_bridge_copies_all_runtime_migrations(tmp_path):
    repo = tmp_path / "repo"
    migrations = repo / "packages" / "core" / "src" / "spans" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "001_initial.sql").write_text("CREATE TABLE first(id TEXT);\n", encoding="utf-8")
    (migrations / "002_retrieval_core.sql").write_text("CREATE TABLE second(id TEXT);\n", encoding="utf-8")
    build_dir = tmp_path / "build"

    _copy_runtime_migrations(repo, build_dir)

    assert _runtime_migrations_ready(repo, build_dir) is True
    assert (build_dir / "spans" / "migrations" / "001_initial.sql").exists()
    assert (build_dir / "spans" / "migrations" / "002_retrieval_core.sql").exists()
    assert _source_mtime(repo) >= (migrations / "002_retrieval_core.sql").stat().st_mtime

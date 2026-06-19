import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "hermes-plugin" / "noemaloom"))

import noemaloom_bridge
from noemaloom_bridge import _format_exception, _timeout_envelope


def test_bridge_formats_nested_exception_groups():
    nested = ExceptionGroup("outer", [RuntimeError("inner boom"), ValueError("bad value")])

    message = _format_exception(nested)

    assert "ExceptionGroup: outer" in message
    assert "RuntimeError: inner boom" in message
    assert "ValueError: bad value" in message


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

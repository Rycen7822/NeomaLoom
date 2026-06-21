from __future__ import annotations

import io
import json
import sys
from pathlib import Path

from nl_rpg_projection_worker import main as worker_main
from nl_rpg_projection_worker.graph_query import query_features
from nl_rpg_projection_worker.protocol import handle_request
from nl_rpg_projection_worker.projection import import_existing_projection


def test_handle_request_rejects_non_object_request() -> None:
    response = handle_request(["feature.status"])  # type: ignore[arg-type]

    assert response["ok"] is False
    assert response["error"]["code"] == "invalid_request"


def test_main_rejects_oversized_stdin_line(monkeypatch) -> None:
    monkeypatch.setattr(worker_main, "MAX_STDIN_LINE_BYTES", 10)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"command": "feature.status", "payload": {}}) + "\n"))
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stdout", captured)

    assert worker_main.main() == 0
    response = json.loads(captured.getvalue())
    assert response["ok"] is False
    assert response["error"]["code"] == "request_too_large"


def test_graph_query_ignores_invalid_or_non_list_features_json(tmp_path: Path) -> None:
    planning = tmp_path / "planning"
    planning.mkdir()
    (planning / "features.json").write_text('{not json', encoding="utf-8")
    assert query_features(tmp_path, "anything") == []

    (planning / "features.json").write_text(json.dumps({"id": "not-a-list"}), encoding="utf-8")
    assert query_features(tmp_path, "anything") == []


def test_import_existing_projection_ignores_invalid_json_without_throwing(tmp_path: Path) -> None:
    data = tmp_path / ".rpgkit" / "data"
    data.mkdir(parents=True)
    (data / "rpg.json").write_text('{not json', encoding="utf-8")

    result = import_existing_projection(tmp_path, tmp_path / ".noemaloom", "rev-test")

    assert result["state"] == "unavailable"

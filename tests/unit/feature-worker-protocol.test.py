import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "nl_rpg_projection_worker"))

from nl_rpg_projection_worker.protocol import COMMANDS, handle_request


def test_protocol_accepts_fixed_commands(tmp_path):
    project_root = tmp_path / "repo"
    state_dir = project_root / ".noemaloom"
    project_root.mkdir()

    for command in COMMANDS:
        response = handle_request(
            {"command": command, "payload": {"query": "docs"}},
            env={
                "NOEMALOOM_PROJECT_ROOT": str(project_root),
                "NOEMALOOM_STATE_DIR": str(state_dir),
                "NOEMALOOM_GRAPH_REVISION": "rev-1",
            },
        )
        assert response["ok"] is True
        assert response["command"] == command


def test_protocol_rejects_unknown_command(tmp_path):
    project_root = tmp_path / "repo"
    project_root.mkdir()

    response = handle_request(
        {"command": "feature.generate"},
        env={"NOEMALOOM_PROJECT_ROOT": str(project_root)},
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "unknown_command"


def test_protocol_queries_projected_features(tmp_path):
    project_root = tmp_path / "repo"
    state_dir = project_root / ".noemaloom"
    project_root.mkdir()
    (project_root / "package.json").write_text('{"name":"query-demo"}', encoding="utf-8")
    env = {
        "NOEMALOOM_PROJECT_ROOT": str(project_root),
        "NOEMALOOM_STATE_DIR": str(state_dir),
        "NOEMALOOM_GRAPH_REVISION": "rev-query",
    }

    assert handle_request({"command": "feature.project_from_repo"}, env=env)["ok"] is True
    query = handle_request({"command": "feature.query", "payload": {"query": "query-demo"}}, env=env)
    detail = handle_request({"command": "feature.detail", "payload": {"id": "package:query-demo"}}, env=env)
    tree = handle_request({"command": "feature.tree"}, env=env)

    assert query["data"]["results"] == [{"id": "package:query-demo", "title": "Package query-demo", "source": "package"}]
    assert detail["data"]["feature"] == {"id": "package:query-demo", "title": "Package query-demo", "source": "package"}
    assert tree["data"]["tree"] == {
        "package": [{"id": "package:query-demo", "title": "Package query-demo", "source": "package"}]
    }

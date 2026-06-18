import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "nl_rpg_projection_worker"))

from nl_rpg_projection_worker.deterministic_projection import project_from_repo


def write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_deterministic_projection_is_stable(tmp_path):
    project_root = tmp_path / "repo"
    state_dir = project_root / ".noemaloom"
    write(project_root / "package.json", json.dumps({"name": "demo"}))
    write(project_root / "docs" / "guide.md", "# Guide\n\n## Setup\n")
    write(project_root / "src" / "client.ts", "export function createClient() {}\n")
    write(project_root / "tests" / "test_client.py", "def test_client():\n    assert True\n")

    first = project_from_repo(project_root, state_dir, "rev-stable")
    snapshot = {
        name: (state_dir / "planning" / name).read_text(encoding="utf-8")
        for name in ["features.json", "rpg.json", "dep_graph.json", "tasks.json", "projection-meta.json"]
    }
    second = project_from_repo(project_root, state_dir, "rev-stable")

    assert first == second
    assert snapshot == {
        name: (state_dir / "planning" / name).read_text(encoding="utf-8")
        for name in snapshot
    }
    features = json.loads(snapshot["features.json"])
    assert [feature["id"] for feature in features] == sorted(feature["id"] for feature in features)
    assert {"id": "package:demo", "title": "Package demo", "source": "package"} in features
    assert {"id": "source:src/client.ts", "title": "src/client.ts", "source": "source"} in features


def test_deterministic_projection_refuses_state_dir_outside_noemaloom(tmp_path):
    project_root = tmp_path / "repo"
    project_root.mkdir()

    try:
        project_from_repo(project_root, tmp_path / "outside", "rev-stable")
    except ValueError as error:
        assert "inside" in str(error)
    else:
        raise AssertionError("expected project_from_repo to reject an outside state dir")

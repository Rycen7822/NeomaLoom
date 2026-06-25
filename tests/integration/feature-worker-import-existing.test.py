import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "nl_rpg_projection_worker"))

from nl_rpg_projection_worker.projection import import_existing_projection


def test_import_existing_rpgkit_data_without_modifying_rpgkit(tmp_path):
    project_root = tmp_path / "repo"
    rpgkit_data = project_root / ".rpgkit" / "data"
    state_dir = project_root / ".noemaloom"
    rpgkit_data.mkdir(parents=True)
    rpg_text = json.dumps({"features": [{"id": "feature.docs", "title": "Docs"}]})
    dep_text = json.dumps({"edges": [{"source": "feature.docs", "target": "feature.api"}]})
    (rpgkit_data / "rpg.json").write_text(rpg_text, encoding="utf-8")
    (rpgkit_data / "dep_graph.json").write_text(dep_text, encoding="utf-8")

    result = import_existing_projection(project_root, state_dir, "rev-import")

    assert result["state"] == "available"
    assert (rpgkit_data / "rpg.json").read_text(encoding="utf-8") == rpg_text
    assert (rpgkit_data / "dep_graph.json").read_text(encoding="utf-8") == dep_text
    assert json.loads((state_dir / "planning" / "features.json").read_text(encoding="utf-8")) == [
        {"id": "feature.docs", "title": "Docs", "source": "rpgkit"}
    ]
    assert (state_dir / "planning" / "rpg.json").exists()
    assert (state_dir / "planning" / "dep_graph.json").exists()
    assert (state_dir / "planning" / "tasks.json").exists()
    assert (state_dir / "planning" / "projection-meta.json").exists()


def test_import_existing_replaces_projection_symlinks_without_following_them(tmp_path):
    if not hasattr(os, "symlink"):
        return
    project_root = tmp_path / "repo"
    rpgkit_data = project_root / ".rpgkit" / "data"
    state_dir = project_root / ".noemaloom"
    planning_dir = state_dir / "planning"
    outside = tmp_path / "outside.json"
    rpgkit_data.mkdir(parents=True)
    planning_dir.mkdir(parents=True)
    outside.write_text("outside-secret\n", encoding="utf-8")
    (planning_dir / "features.json").symlink_to(outside)
    (rpgkit_data / "rpg.json").write_text(json.dumps({"features": [{"id": "feature.docs", "title": "Docs"}]}), encoding="utf-8")

    result = import_existing_projection(project_root, state_dir, "rev-symlink")

    assert result["state"] == "available"
    assert outside.read_text(encoding="utf-8") == "outside-secret\n"
    assert not (planning_dir / "features.json").is_symlink()
    assert json.loads((planning_dir / "features.json").read_text(encoding="utf-8")) == [
        {"id": "feature.docs", "title": "Docs", "source": "rpgkit"}
    ]


def test_import_existing_refuses_state_dir_outside_noemaloom(tmp_path):
    project_root = tmp_path / "repo"
    rpgkit_data = project_root / ".rpgkit" / "data"
    rpgkit_data.mkdir(parents=True)
    (rpgkit_data / "rpg.json").write_text(json.dumps({"features": [{"id": "feature.docs"}]}), encoding="utf-8")

    try:
        import_existing_projection(project_root, tmp_path / "outside", "rev-import")
    except ValueError as error:
        assert "inside" in str(error)
    else:
        raise AssertionError("expected import_existing_projection to reject an outside state dir")

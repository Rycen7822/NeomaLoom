import json
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

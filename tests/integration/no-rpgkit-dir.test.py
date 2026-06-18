import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "nl_rpg_projection_worker"))

from nl_rpg_projection_worker.deterministic_projection import project_from_repo


def test_projection_does_not_create_rpgkit_directory(tmp_path):
    project_root = tmp_path / "repo"
    state_dir = project_root / ".noemaloom"
    (project_root / "src").mkdir(parents=True)
    (project_root / "src" / "main.py").write_text("def main():\n    return 1\n", encoding="utf-8")

    result = project_from_repo(project_root, state_dir, "rev-no-rpgkit")

    assert result["state"] == "available"
    assert not (project_root / ".rpgkit").exists()
    assert (state_dir / "planning" / "features.json").exists()

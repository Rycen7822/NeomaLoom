import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "nl_rpg_projection_worker"))

from nl_rpg_projection_worker.normalizer import normalize_existing_projection


def test_normalizes_existing_rpg_and_dep_graph():
    normalized = normalize_existing_projection(
        rpg={
            "features": [{"id": "feature.docs", "title": "Docs"}],
            "tasks": [{"id": "task.docs.verify", "title": "Verify docs"}],
        },
        dep_graph={"edges": [{"source": "feature.docs", "target": "feature.api"}]},
        revision="rev-1",
    )

    assert normalized["features"] == [
        {"id": "feature.docs", "title": "Docs", "source": "rpgkit"}
    ]
    assert normalized["tasks"] == [
        {"id": "task.docs.verify", "title": "Verify docs", "source": "rpgkit"}
    ]
    assert normalized["dep_graph"]["edges"] == [
        {"source": "feature.docs", "target": "feature.api", "relation": "depends_on"}
    ]
    assert normalized["meta"]["revision"] == "rev-1"
    assert normalized["meta"]["source"] == "rpgkit"

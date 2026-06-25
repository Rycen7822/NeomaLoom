from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
from typing import Any

from .normalizer import normalize_existing_projection
from .paths import WorkerPaths, build_worker_paths, ensure_planning_dir

PROJECTION_FILES = {
    "features": "features.json",
    "rpg": "rpg.json",
    "dep_graph": "dep_graph.json",
    "tasks": "tasks.json",
    "meta": "projection-meta.json",
}
MAX_WORKER_JSON_BYTES = 10_000_000


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        if path.stat().st_size > MAX_WORKER_JSON_BYTES:
            return None
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def write_projection(paths: WorkerPaths, projection: dict[str, Any]) -> None:
    ensure_planning_dir(paths)
    for key, filename in PROJECTION_FILES.items():
        target = paths.planning_file(filename)
        text = json.dumps(projection[key], sort_keys=True, indent=2) + "\n"
        fd, temp_name = tempfile.mkstemp(prefix=f".{filename}.", suffix=".tmp", dir=target.parent)
        temp_path = Path(temp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            temp_path.replace(target)
        except Exception:
            try:
                temp_path.unlink()
            except OSError:
                pass
            raise


def import_existing_projection(project_root: Path, state_dir: Path, revision: str) -> dict[str, Any]:
    rpgkit_data = project_root / ".rpgkit" / "data"
    rpg = _read_json(rpgkit_data / "rpg.json")
    dep_graph = _read_json(rpgkit_data / "dep_graph.json")
    paths = build_worker_paths(project_root, state_dir, revision)

    if rpg is None and dep_graph is None:
        return {
            "state": "unavailable",
            "warnings": ["No .rpgkit/data/rpg.json or dep_graph.json found."],
        }

    projection = normalize_existing_projection(rpg, dep_graph, revision)
    write_projection(paths, projection)
    return {
        "state": "available",
        "featureCount": len(projection["features"]),
        "taskCount": len(projection["tasks"]),
    }

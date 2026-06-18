from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


@dataclass(frozen=True)
class WorkerPaths:
    project_root: Path
    state_dir: Path
    planning_dir: Path
    revision: str

    def planning_file(self, name: str) -> Path:
        target = (self.planning_dir / name).resolve()
        if self.planning_dir.resolve() not in [target, *target.parents]:
            raise ValueError(f"Refusing to write outside planning dir: {target}")
        return target


def build_worker_paths(project_root: Path, state_dir: Path, revision: str) -> WorkerPaths:
    resolved_project_root = project_root.resolve()
    resolved_state_dir = state_dir.resolve()
    expected_state = (resolved_project_root / ".noemaloom").resolve()
    if resolved_state_dir != expected_state:
        try:
            resolved_state_dir.relative_to(expected_state)
        except ValueError as error:
            raise ValueError(f"NOEMALOOM_STATE_DIR must be inside {expected_state}: {resolved_state_dir}") from error

    return WorkerPaths(
        project_root=resolved_project_root,
        state_dir=resolved_state_dir,
        planning_dir=resolved_state_dir / "planning",
        revision=revision,
    )


def paths_from_env(env: Mapping[str, str] | None = None) -> WorkerPaths:
    values = env if env is not None else os.environ
    project_root = Path(values.get("NOEMALOOM_PROJECT_ROOT", ".")).resolve()
    state_dir = Path(values.get("NOEMALOOM_STATE_DIR", str(project_root / ".noemaloom"))).resolve()
    revision = values.get("NOEMALOOM_GRAPH_REVISION", "unknown")

    return build_worker_paths(project_root, state_dir, revision)


def ensure_planning_dir(paths: WorkerPaths) -> None:
    paths.planning_dir.mkdir(parents=True, exist_ok=True)

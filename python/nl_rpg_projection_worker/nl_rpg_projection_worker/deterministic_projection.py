from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Iterable

from .paths import build_worker_paths
from .projection import write_projection

IGNORED_DIRS = {
    ".git",
    ".noemaloom",
    ".rpgkit",
    ".venv",
    "venv",
    "node_modules",
    "dist",
    "build",
    "target",
    "coverage",
    "vendor",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "reference",
    "worknotes",
}
CODE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".scala"}
MAX_WORKER_FILE_BYTES = 1_048_576


def _iter_repo_files(project_root: Path) -> Iterable[Path]:
    for current_root, dirnames, filenames in os.walk(project_root):
        dirnames[:] = sorted(name for name in dirnames if name not in IGNORED_DIRS)
        current = Path(current_root)
        for name in sorted(filenames):
            path = current / name
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                if path.stat().st_size > MAX_WORKER_FILE_BYTES:
                    continue
                relative = path.relative_to(project_root)
            except OSError:
                continue
            if any(part in IGNORED_DIRS for part in relative.parts):
                continue
            yield relative


def _read_text(project_root: Path, relative: Path) -> str:
    target = project_root / relative
    try:
        if target.is_symlink() or not target.is_file():
            return ""
        if target.stat().st_size > MAX_WORKER_FILE_BYTES:
            return ""
        return target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "section"


def _package_features(project_root: Path) -> list[dict[str, str]]:
    text = _read_text(project_root, Path("package.json"))
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    name = str(data.get("name") or "package")
    return [{"id": f"package:{name}", "title": f"Package {name}", "source": "package"}]


def _doc_features(project_root: Path, relative: Path) -> list[dict[str, str]]:
    features: list[dict[str, str]] = []
    for line in _read_text(project_root, relative).splitlines():
        match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if match:
            title = match.group(2).strip()
            features.append({
                "id": f"doc:{relative.as_posix()}#{_slug(title)}",
                "title": title,
                "source": "docs",
            })
    return features


def _test_features(project_root: Path, relative: Path) -> list[dict[str, str]]:
    text = _read_text(project_root, relative)
    names = re.findall(r"\bdef\s+(test_[A-Za-z0-9_]+)\s*\(", text)
    names += re.findall(r"\b(?:test|it)\(\s*['\"]([^'\"]+)['\"]", text)
    return [
        {
            "id": f"test:{relative.as_posix()}:{_slug(name)}",
            "title": name,
            "source": "test",
        }
        for name in names
    ]


def build_deterministic_projection(project_root: Path, revision: str) -> dict[str, Any]:
    features: list[dict[str, str]] = []
    features.extend(_package_features(project_root))

    for relative in _iter_repo_files(project_root):
        relative_posix = relative.as_posix()
        if relative.suffix in {".md", ".mdx"}:
            features.extend(_doc_features(project_root, relative))
        if relative.suffix in CODE_SUFFIXES and relative_posix.startswith(("src/", "lib/", "packages/")):
            features.append({"id": f"source:{relative_posix}", "title": relative_posix, "source": "source"})
        if "test" in relative.parts or relative_posix.startswith("tests/"):
            features.extend(_test_features(project_root, relative))

    unique = {feature["id"]: feature for feature in features}
    features = [unique[key] for key in sorted(unique)]
    tasks = [
        {
            "id": f"task:{feature['id']}:verify",
            "title": f"Verify {feature['title']}",
            "feature": feature["id"],
            "source": "deterministic",
        }
        for feature in features
    ]

    return {
        "features": features,
        "rpg": {"features": features, "tasks": tasks},
        "dep_graph": {"nodes": [{"id": feature["id"]} for feature in features], "edges": []},
        "tasks": tasks,
        "meta": {"revision": revision, "source": "deterministic"},
    }


def project_from_repo(project_root: Path, state_dir: Path, revision: str) -> dict[str, Any]:
    paths = build_worker_paths(project_root, state_dir, revision)
    projection = build_deterministic_projection(project_root, revision)
    write_projection(paths, projection)
    return {
        "state": "available",
        "featureCount": len(projection["features"]),
        "taskCount": len(projection["tasks"]),
    }

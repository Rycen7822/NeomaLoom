from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MAX_WORKER_JSON_BYTES = 10_000_000


def _features(state_dir: Path) -> list[dict[str, Any]]:
    path = state_dir / "planning" / "features.json"
    if not path.exists():
        return []
    try:
        if path.stat().st_size > MAX_WORKER_JSON_BYTES:
            return []
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []


def query_features(state_dir: Path, query: str, limit: int = 20) -> list[dict[str, Any]]:
    needle = query.lower()
    results = [
        feature for feature in _features(state_dir)
        if needle in feature.get("id", "").lower() or needle in feature.get("title", "").lower()
    ]
    return results[:limit]


def detail_feature(state_dir: Path, feature_id: str) -> dict[str, Any] | None:
    for feature in _features(state_dir):
        if feature.get("id") == feature_id:
            return feature
    return None


def feature_tree(state_dir: Path) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for feature in _features(state_dir):
        grouped.setdefault(str(feature.get("source", "unknown")), []).append(feature)
    return {key: sorted(value, key=lambda item: item["id"]) for key, value in sorted(grouped.items())}

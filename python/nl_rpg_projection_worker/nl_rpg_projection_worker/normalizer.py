from __future__ import annotations

from typing import Any


def _stable_id(prefix: str, value: str) -> str:
    clean = value.strip().lower().replace(" ", ".").replace("/", ".")
    return f"{prefix}.{clean}" if clean else f"{prefix}.unknown"


def _normalize_feature(raw: dict[str, Any]) -> dict[str, str]:
    title = str(raw.get("title") or raw.get("name") or raw.get("id") or "Untitled")
    feature_id = str(raw.get("id") or _stable_id("feature", title))
    return {
        "id": feature_id,
        "title": title,
        "source": "rpgkit",
    }


def _normalize_task(raw: dict[str, Any]) -> dict[str, str]:
    title = str(raw.get("title") or raw.get("name") or raw.get("id") or "Untitled task")
    task_id = str(raw.get("id") or _stable_id("task", title))
    return {
        "id": task_id,
        "title": title,
        "source": "rpgkit",
    }


def _normalize_edge(raw: dict[str, Any]) -> dict[str, str]:
    return {
        "source": str(raw.get("source") or raw.get("from") or ""),
        "target": str(raw.get("target") or raw.get("to") or ""),
        "relation": str(raw.get("relation") or raw.get("kind") or "depends_on"),
    }


def normalize_existing_projection(
    rpg: dict[str, Any] | None,
    dep_graph: dict[str, Any] | None,
    revision: str,
) -> dict[str, Any]:
    rpg = rpg or {}
    dep_graph = dep_graph or {}
    features = sorted((_normalize_feature(item) for item in rpg.get("features", [])), key=lambda item: item["id"])
    tasks = sorted((_normalize_task(item) for item in rpg.get("tasks", [])), key=lambda item: item["id"])
    edges = sorted(
        (_normalize_edge(item) for item in dep_graph.get("edges", [])),
        key=lambda item: (item["source"], item["target"], item["relation"]),
    )
    edges = [edge for edge in edges if edge["source"] and edge["target"]]

    return {
        "features": features,
        "rpg": {
            "features": features,
            "tasks": tasks,
        },
        "dep_graph": {
            "nodes": [{"id": feature["id"]} for feature in features],
            "edges": edges,
        },
        "tasks": tasks,
        "meta": {
            "revision": revision,
            "source": "rpgkit",
        },
    }

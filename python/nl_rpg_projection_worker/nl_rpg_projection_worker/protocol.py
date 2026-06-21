from __future__ import annotations

from typing import Any, Mapping

from .deterministic_projection import project_from_repo
from .graph_query import detail_feature, feature_tree, query_features
from .paths import paths_from_env
from .projection import import_existing_projection

COMMANDS = (
    "feature.status",
    "feature.import_existing",
    "feature.project_from_repo",
    "feature.update_changed",
    "feature.query",
    "feature.explore",
    "feature.detail",
    "feature.tree",
)


def _ok(command: str, data: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "command": command, "data": data}


def _error(command: str, code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "command": command, "error": {"code": code, "message": message}}


def handle_request(request: dict[str, Any], env: Mapping[str, str] | None = None) -> dict[str, Any]:
    if not isinstance(request, dict):
        return _error("", "invalid_request", "Feature worker request must be a JSON object.")
    command = str(request.get("command", ""))
    payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
    if command not in COMMANDS:
        return _error(command, "unknown_command", f"Unknown feature worker command: {command}")

    try:
        paths = paths_from_env(env)
        if command == "feature.status":
            return _ok(command, {
                "state": "available",
                "projectRoot": str(paths.project_root),
                "stateDir": str(paths.state_dir),
                "revision": paths.revision,
            })
        if command == "feature.import_existing":
            return _ok(command, import_existing_projection(paths.project_root, paths.state_dir, paths.revision))
        if command in {"feature.project_from_repo", "feature.update_changed"}:
            return _ok(command, project_from_repo(paths.project_root, paths.state_dir, paths.revision))
        if command in {"feature.query", "feature.explore"}:
            return _ok(command, {
                "results": query_features(paths.state_dir, str(payload.get("query", "")), int(payload.get("limit", 20)))
            })
        if command == "feature.detail":
            return _ok(command, {"feature": detail_feature(paths.state_dir, str(payload.get("id", "")))})
        if command == "feature.tree":
            return _ok(command, {"tree": feature_tree(paths.state_dir)})
    except Exception as error:  # pragma: no cover - defensive protocol boundary
        return _error(command, "command_failed", str(error))

    return _error(command, "unknown_command", f"Unhandled command: {command}")

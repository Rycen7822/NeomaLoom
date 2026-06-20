"""Optional Hermes hooks for project-local NoemaLoom navigation anchors.

The hooks are intentionally silent unless the current project has opted in via
`.noemaloom/workset/anchors.json` with `options.navigation.enabled=true` and
`mode="inject"`. They never use global memory and never call the NoemaLoom MCP
subprocess on the pre-LLM path.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_READ_WRITE_TOOL_NAMES = {
    "read_file",
    "nl_read_span",
    "patch",
    "write_file",
    "nl_verify_task",
}


def _is_mapping(value: Any) -> bool:
    return isinstance(value, dict)


def _extract_from_mapping(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = payload.get(key)
        if value:
            return value
    return None


def _context_dict(context: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    if _is_mapping(context):
        merged = dict(context)
        merged.update(kwargs)
        return merged
    return dict(kwargs)


def _candidate_root_values(context: Any = None, **kwargs: Any) -> list[str]:
    payload = _context_dict(context, kwargs)
    values: list[str] = []
    direct = _extract_from_mapping(payload, "projectPath", "projectRoot", "workdir", "cwd")
    if isinstance(direct, str):
        values.append(direct)
    tool_args = payload.get("args") or payload.get("tool_args") or payload.get("arguments")
    if isinstance(tool_args, dict):
        nested = _extract_from_mapping(tool_args, "projectPath", "projectRoot", "workdir", "cwd")
        if isinstance(nested, str):
            values.append(nested)
    values.append(os.getcwd())
    return values


def _find_project_root(context: Any = None, **kwargs: Any) -> Path | None:
    for raw in _candidate_root_values(context, **kwargs):
        try:
            current = Path(raw).expanduser().resolve()
        except Exception:
            continue
        if current.is_file():
            current = current.parent
        for candidate in [current, *current.parents]:
            manifest = candidate / ".noemaloom" / "workset" / "anchors.json"
            if manifest.exists():
                return candidate
    return None


def _manifest_path(project_root: Path) -> Path:
    state_dir = (project_root / ".noemaloom").resolve()
    manifest = (state_dir / "workset" / "anchors.json").resolve()
    try:
        manifest.relative_to(state_dir)
    except ValueError as exc:
        raise RuntimeError(f"refusing navigation state outside .noemaloom: {manifest}") from exc
    return manifest


def _load_manifest(project_root: Path) -> dict[str, Any] | None:
    try:
        manifest_path = _manifest_path(project_root)
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_manifest(project_root: Path, manifest: dict[str, Any]) -> None:
    manifest_path = _manifest_path(project_root)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _navigation_enabled(manifest: dict[str, Any]) -> bool:
    navigation = ((manifest.get("options") or {}).get("navigation") or {})
    return navigation.get("enabled") is True and navigation.get("mode", "inject") == "inject"


def _rank_anchor(anchor: dict[str, Any]) -> float:
    state = anchor.get("state")
    state_weight = 1000 if state == "active" else 100 if state == "dormant" else 10 if state == "archived" else -1000
    pinned_weight = 500 if anchor.get("pinned") is True else 0
    return (
        state_weight
        + pinned_weight
        + float(anchor.get("score") or 0)
        + float(anchor.get("usefulHitCount") or 0) * 10
        - float(anchor.get("ignoredInjectionCount") or 0) * 5
        + float(anchor.get("lastSeenSeq") or 0) / 1000
    )


def _anchor_line(anchor: dict[str, Any]) -> str:
    path = str(anchor.get("path") or "")
    label = str(anchor.get("label") or path)
    kind = str(anchor.get("kind") or "file")
    role = str(anchor.get("role") or "source_file")
    reason = str(anchor.get("reason") or "navigation anchor")
    start = anchor.get("startLine")
    end = anchor.get("endLine")
    line_part = f":{start}-{end}" if isinstance(start, int) and isinstance(end, int) else ""
    pin = " pinned" if anchor.get("pinned") is True else ""
    return f"- {path}{line_part} [{kind}/{role}{pin}] {label} — {reason}"


def render_navigation_context(manifest: dict[str, Any], *, char_budget: int | None = None, max_anchors: int | None = None) -> str:
    if not _navigation_enabled(manifest):
        return ""
    budgets = manifest.get("budgets") or {}
    limit = int(max_anchors or budgets.get("injectionDefaultAnchors") or 3)
    budget = int(char_budget or budgets.get("injectionDefaultChars") or 650)
    anchors = [anchor for anchor in manifest.get("anchors") or [] if isinstance(anchor, dict) and anchor.get("state") in {"active", "dormant"}]
    anchors = sorted(anchors, key=_rank_anchor, reverse=True)[:limit]
    lines: list[str] = []
    for anchor in anchors:
        line = _anchor_line(anchor)
        candidate = "\n".join([*lines, line])
        if len(candidate) > budget:
            break
        lines.append(line)
    if not lines:
        return ""
    return "\n".join([
        "<NoemaLoom navigation anchors>",
        "Project-local anchors only; use native tools for edits and nl_verify_task after changes.",
        *lines,
        "</NoemaLoom navigation anchors>",
    ])


def pre_llm_call(context: Any = None, **kwargs: Any) -> dict[str, Any]:
    project_root = _find_project_root(context, **kwargs)
    if not project_root:
        return {"context": ""}
    manifest = _load_manifest(project_root)
    if not manifest:
        return {"context": ""}
    return {"context": render_navigation_context(manifest)}


def _tool_name_from_context(context: Any = None, **kwargs: Any) -> str:
    payload = _context_dict(context, kwargs)
    for key in ("tool_name", "tool", "name"):
        value = payload.get(key)
        if isinstance(value, str):
            return value
    return ""


def _tool_paths(context: Any = None, **kwargs: Any) -> set[str]:
    payload = _context_dict(context, kwargs)
    args = payload.get("args") or payload.get("tool_args") or payload.get("arguments") or payload
    paths: set[str] = set()
    if _is_mapping(args):
        for key in ("path", "file", "target", "changedPaths"):
            value = args.get(key)
            if isinstance(value, str):
                paths.add(value)
            elif isinstance(value, list):
                paths.update(item for item in value if isinstance(item, str))
    return paths


def _mark_useful(manifest: dict[str, Any], touched_paths: set[str]) -> bool:
    if not touched_paths:
        return False
    counters = manifest.setdefault("counters", {})
    counters["projectActivitySeq"] = int(counters.get("projectActivitySeq") or 0) + 1
    counters["readWriteSeq"] = int(counters.get("readWriteSeq") or 0) + 1
    seq = counters["readWriteSeq"]
    changed = False
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for anchor in manifest.get("anchors") or []:
        if not isinstance(anchor, dict):
            continue
        anchor_path = anchor.get("path")
        if isinstance(anchor_path, str) and anchor_path in touched_paths:
            anchor["updatedAt"] = now
            anchor["lastUsefulSeq"] = seq
            anchor["usefulHitCount"] = int(anchor.get("usefulHitCount") or 0) + 1
            anchor["ignoredInjectionCount"] = 0
            if anchor.get("state") in {"dormant", "archived"}:
                anchor["state"] = "active"
            changed = True
    return changed


def post_tool_call(context: Any = None, **kwargs: Any) -> dict[str, Any]:
    tool_name = _tool_name_from_context(context, **kwargs)
    if tool_name not in _READ_WRITE_TOOL_NAMES:
        return {"ok": True}
    project_root = _find_project_root(context, **kwargs)
    if not project_root:
        return {"ok": True}
    manifest = _load_manifest(project_root)
    if not manifest or not _navigation_enabled(manifest):
        return {"ok": True}
    if _mark_useful(manifest, _tool_paths(context, **kwargs)):
        try:
            _write_manifest(project_root, manifest)
        except Exception:
            return {"ok": False}
    return {"ok": True}

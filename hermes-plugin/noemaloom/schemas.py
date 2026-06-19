"""Hermes tool schemas for the NoemaLoom plugin."""

from __future__ import annotations

PROJECT_PATH = {
    "type": "string",
    "description": (
        "Repository/workspace root to inspect. If omitted, NoemaLoom uses the "
        "current Hermes working directory."
    ),
}

TARGET_ROLES = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Optional target role filters such as source, document, config, test, example, or feature.",
}

TARGET_TYPE = {
    "type": "string",
    "enum": ["auto", "span", "symbol", "file", "feature", "config", "doc"],
    "description": "How to interpret the target field for impact planning or verification.",
}

PUBLIC_TOOL_NAMES = [
    "nl_status",
    "nl_refresh",
    "nl_prepare_context",
    "nl_plan_change",
    "nl_verify_task",
]

NL_STATUS_SCHEMA = {
    "name": "nl_status",
    "description": (
        "Report NoemaLoom derived-index state for a repository and confirm that raw writer surfaces "
        "are disabled. Start here before refresh, context preparation, planning, or verification."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "projectPath": PROJECT_PATH,
            "includeRepositoryMap": {
                "type": "boolean",
                "description": "Whether status should include repository-map summary data when available.",
                "default": False,
            },
        },
    },
}

NL_REFRESH_SCHEMA = {
    "name": "nl_refresh",
    "description": (
        "Refresh NoemaLoom project-local derived indexes under .noemaloom/. This never edits source "
        "files; it writes only rebuildable cache/index state."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "projectPath": PROJECT_PATH,
            "target": {
                "type": "string",
                "enum": ["all", "changed", "files", "code", "docs", "artifacts", "tests", "features", "links", "map"],
                "default": "all",
                "description": "Index family to refresh. Use changed after verification passes; use all when indexes are missing.",
            },
            "mode": {
                "type": "string",
                "enum": ["safe", "force"],
                "default": "safe",
                "description": "Safe avoids destructive behavior; force may create transient backups before rebuilding derived state.",
            },
        },
    },
}

NL_PREPARE_CONTEXT_SCHEMA = {
    "name": "nl_prepare_context",
    "description": (
        "Prepare compact task context for a repository edit or review goal: ranked targets, coverage "
        "plan, normalized query, and optional top-span reads."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "projectPath": PROJECT_PATH,
            "goal": {"type": "string", "description": "Edit/review goal to localize."},
            "scope": {"type": "string", "description": "Optional scope hint appended to the goal."},
            "targetRoles": TARGET_ROLES,
            "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
            "budget": {"type": "integer", "minimum": 1, "maximum": 10000, "default": 2048},
            "includeSnippets": {"type": "boolean", "default": False},
            "includeQueryPreview": {"type": "boolean", "default": True},
            "readTopSpans": {"type": "boolean", "default": False},
            "maxReadSpans": {"type": "integer", "minimum": 0, "maximum": 10, "default": 3},
            "contextLines": {"type": "integer", "minimum": 0, "maximum": 80, "default": 10},
        },
        "required": ["goal"],
    },
}

NL_PLAN_CHANGE_SCHEMA = {
    "name": "nl_plan_change",
    "description": (
        "Plan likely code/document/config/test impact before a change. Returns targets, trace/impact "
        "context, coverage plan, and required verification hints."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "projectPath": PROJECT_PATH,
            "target": {"type": "string", "description": "Span id, symbol, file, feature, config key, doc path, or natural-language target."},
            "goal": {"type": "string", "description": "Optional user-facing change goal; defaults to target."},
            "targetType": TARGET_TYPE,
            "targetRoles": TARGET_ROLES,
            "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 30},
            "direction": {"type": "string", "enum": ["upstream", "downstream", "both"], "default": "both"},
            "depth": {"type": "integer", "minimum": 0, "maximum": 5, "default": 2},
            "relationTypes": {"type": "array", "items": {"type": "string"}, "default": ["all"]},
            "includeTrace": {"type": "boolean", "default": True},
        },
        "required": ["target"],
    },
}

NL_VERIFY_TASK_SCHEMA = {
    "name": "nl_verify_task",
    "description": (
        "Verify an edited task after native Hermes/Codex file changes. Checks coverage, old/new terms, "
        "links, stale anchors, document synchronization, and optional impact context."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "projectPath": PROJECT_PATH,
            "goal": {"type": "string", "description": "The completed edit/review goal to verify."},
            "changedPaths": {"type": "array", "items": {"type": "string"}, "default": []},
            "oldTerms": {"type": "array", "items": {"type": "string"}, "default": []},
            "newTerms": {"type": "array", "items": {"type": "string"}, "default": []},
            "target": {"type": "string", "description": "Optional target for impact/trace verification."},
            "targetType": TARGET_TYPE,
            "depth": {"type": "integer", "minimum": 0, "maximum": 5, "default": 2},
            "includeImpact": {"type": "boolean", "default": True},
            "includeTrace": {"type": "boolean", "default": False},
        },
        "required": ["goal"],
    },
}

SCHEMAS = {
    "nl_status": NL_STATUS_SCHEMA,
    "nl_refresh": NL_REFRESH_SCHEMA,
    "nl_prepare_context": NL_PREPARE_CONTEXT_SCHEMA,
    "nl_plan_change": NL_PLAN_CHANGE_SCHEMA,
    "nl_verify_task": NL_VERIFY_TASK_SCHEMA,
}

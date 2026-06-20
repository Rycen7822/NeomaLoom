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
    "nl_anchor_status",
    "nl_anchor_promote",
    "nl_anchor_demote",
    "nl_anchor_repair",
    "nl_anchor_retire",
    "nl_anchor_checkpoint",
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
                "enum": ["all", "changed", "files", "paths", "hotset", "code", "docs", "artifacts", "tests", "features", "links", "map"],
                "default": "all",
                "description": "Index family to refresh. Use files for inventory-only, paths to promote exact files into the scoped hotset, hotset to refresh the current hotset, changed after verification passes, and all when a full index is needed.",
            },
            "paths": {
                "type": "array",
                "items": {"type": "string"},
                "default": [],
                "description": "Repository-relative paths to promote when target is paths.",
            },
            "promotionReason": {
                "type": "string",
                "description": "Optional reason recorded in the hotset manifest when target is paths.",
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
            "budget": {"type": "integer", "minimum": 1, "maximum": 10000, "default": 2400},
            "includeSnippets": {"type": "boolean", "default": False},
            "includeQueryPreview": {"type": "boolean", "default": True},
            "readTopSpans": {"type": "boolean", "default": False},
            "maxReadSpans": {"type": "integer", "minimum": 0, "maximum": 10, "default": 3},
            "contextLines": {"type": "integer", "minimum": 0, "maximum": 80, "default": 10},
            "responseProfile": {
                "type": "string",
                "enum": ["compact", "standard", "debug", "navigation"],
                "default": "compact",
                "description": "Output profile. compact preserves actionable targets, coverage, warnings, read spans, and required actions while summarizing debug-heavy details; navigation returns short project-local anchor cards and essential targets; debug preserves full diagnostic payloads.",
            },
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
            "responseProfile": {
                "type": "string",
                "enum": ["compact", "standard", "debug"],
                "default": "compact",
                "description": "Output profile. compact summarizes trace/impact and target diagnostics while preserving required verification and actions; debug preserves full trace/impact payloads.",
            },
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

ANCHOR_SELECTOR_PROPERTIES = {
    "projectPath": PROJECT_PATH,
    "anchorId": {"type": "string", "description": "Exact navigation anchor id from nl_anchor_status."},
    "path": {"type": "string", "description": "Repository-relative anchor path when anchorId is not provided."},
    "reason": {"type": "string", "default": "agent curation", "description": "Audit reason for the controlled curation action."},
}

NL_ANCHOR_STATUS_SCHEMA = {
    "name": "nl_anchor_status",
    "description": "Inspect project-local NoemaLoom navigation anchors, lifecycle counters, budgets, and rendered cards.",
    "parameters": {
        "type": "object",
        "properties": {
            "projectPath": PROJECT_PATH,
            "includeRetired": {"type": "boolean", "default": False},
            "includeText": {"type": "boolean", "default": True},
            "responseProfile": {"type": "string", "enum": ["compact", "standard", "debug"], "default": "compact"},
        },
    },
}

NL_ANCHOR_PROMOTE_SCHEMA = {
    "name": "nl_anchor_promote",
    "description": "Promote a path/span into the project-local navigation anchor pool through a controlled operation, not raw JSON writes.",
    "parameters": {
        "type": "object",
        "properties": {
            "projectPath": PROJECT_PATH,
            "path": {"type": "string", "description": "Repository-relative path to promote."},
            "label": {"type": "string"},
            "kind": {"type": "string", "default": "file"},
            "role": {"type": "string", "default": "source_file"},
            "startLine": {"type": "integer", "minimum": 1},
            "endLine": {"type": "integer", "minimum": 1},
            "reason": {"type": "string", "default": "agent promoted anchor"},
            "pinned": {"type": "boolean", "default": False},
            "enableNavigation": {"type": "boolean", "description": "Optional explicit project-local injection opt-in/out."},
        },
        "required": ["path"],
    },
}

NL_ANCHOR_DEMOTE_SCHEMA = {
    "name": "nl_anchor_demote",
    "description": "Demote an existing navigation anchor to dormant or archived using activity-count lifecycle state.",
    "parameters": {
        "type": "object",
        "properties": {
            **ANCHOR_SELECTOR_PROPERTIES,
            "state": {"type": "string", "enum": ["dormant", "archived"], "default": "dormant"},
        },
    },
}

NL_ANCHOR_REPAIR_SCHEMA = {
    "name": "nl_anchor_repair",
    "description": "Repair an existing navigation anchor path, label, kind, role, or line range without raw JSON edits.",
    "parameters": {
        "type": "object",
        "properties": {
            **ANCHOR_SELECTOR_PROPERTIES,
            "newPath": {"type": "string"},
            "label": {"type": "string"},
            "startLine": {"type": "integer", "minimum": 1},
            "endLine": {"type": "integer", "minimum": 1},
            "kind": {"type": "string"},
            "role": {"type": "string"},
        },
    },
}

NL_ANCHOR_RETIRE_SCHEMA = {
    "name": "nl_anchor_retire",
    "description": "Retire an obsolete navigation anchor and write a tombstone so later locator hits do not revive it.",
    "parameters": {
        "type": "object",
        "properties": ANCHOR_SELECTOR_PROPERTIES,
    },
}

NL_ANCHOR_CHECKPOINT_SCHEMA = {
    "name": "nl_anchor_checkpoint",
    "description": "Update project-local navigation-anchor checkpoint metadata, including explicit injection enablement.",
    "parameters": {
        "type": "object",
        "properties": {
            "projectPath": PROJECT_PATH,
            "enabled": {"type": "boolean", "description": "Enable/disable project-local pre-LLM navigation injection."},
            "mode": {"type": "string", "enum": ["silent", "inject"]},
            "reason": {"type": "string", "default": "agent checkpoint"},
        },
    },
}

SCHEMAS = {
    "nl_status": NL_STATUS_SCHEMA,
    "nl_refresh": NL_REFRESH_SCHEMA,
    "nl_prepare_context": NL_PREPARE_CONTEXT_SCHEMA,
    "nl_plan_change": NL_PLAN_CHANGE_SCHEMA,
    "nl_verify_task": NL_VERIFY_TASK_SCHEMA,
    "nl_anchor_status": NL_ANCHOR_STATUS_SCHEMA,
    "nl_anchor_promote": NL_ANCHOR_PROMOTE_SCHEMA,
    "nl_anchor_demote": NL_ANCHOR_DEMOTE_SCHEMA,
    "nl_anchor_repair": NL_ANCHOR_REPAIR_SCHEMA,
    "nl_anchor_retire": NL_ANCHOR_RETIRE_SCHEMA,
    "nl_anchor_checkpoint": NL_ANCHOR_CHECKPOINT_SCHEMA,
}

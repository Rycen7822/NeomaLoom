"""NoemaLoom Hermes plugin.

This plugin registers the curated NoemaLoom tool surface directly in Hermes.
It intentionally does not expose raw backend primitives or writer tools.
"""

from __future__ import annotations

from pathlib import Path

from .noemaloom_bridge import make_handler
from .navigation_hooks import pre_llm_call, post_tool_call
from .schemas import SCHEMAS

_TOOL_DESCRIPTIONS = {
    "nl_status": "Inspect NoemaLoom index state and safety flags before repository-localization work.",
    "nl_refresh": "Refresh project-local .noemaloom/ derived indexes without editing source files.",
    "nl_prepare_context": "Prepare compact repository context and ranked edit targets for a user goal.",
    "nl_plan_change": "Plan cross-surface impact before code, API, config, documentation, or test changes.",
    "nl_verify_task": "Verify task coverage after native Hermes/Codex file edits before refreshing changed indexes.",
    "nl_anchor_status": "Inspect project-local NoemaLoom navigation anchors and lifecycle counters.",
    "nl_anchor_promote": "Promote a project-local navigation anchor through a controlled curation tool.",
    "nl_anchor_demote": "Demote a project-local navigation anchor to dormant or archived.",
    "nl_anchor_repair": "Repair a project-local navigation anchor path, label, or line range.",
    "nl_anchor_retire": "Retire a project-local navigation anchor and write a tombstone.",
    "nl_anchor_checkpoint": "Update project-local navigation-anchor checkpoint metadata and explicit enablement.",
}


def register(ctx) -> None:
    """Register NoemaLoom tools and bundled usage skill."""
    for name, schema in SCHEMAS.items():
        ctx.register_tool(
            name=name,
            toolset="noemaloom",
            schema=schema,
            handler=make_handler(name),
            description=f"{_TOOL_DESCRIPTIONS[name]} Load skill_view(name=\"noemaloom:usage\") for workflow guidance.",
            emoji="🧵",
        )

    if hasattr(ctx, "register_hook"):
        ctx.register_hook("pre_llm_call", pre_llm_call)
        ctx.register_hook("post_tool_call", post_tool_call)

    skill_path = Path(__file__).parent / "resources" / "skills" / "usage" / "SKILL.md"
    ctx.register_skill(
        "usage",
        skill_path,
        "NoemaLoom operator workflow for Hermes: status, refresh, context preparation, change planning, and coverage verification.",
    )

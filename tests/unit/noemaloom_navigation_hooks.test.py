# pyright: reportMissingImports=false

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "hermes-plugin"))

from noemaloom import register
from noemaloom.navigation_hooks import _manifest_lock_path, post_tool_call, pre_llm_call


def write_manifest(
    project_root: Path,
    *,
    enabled: bool = False,
    mode: str = "silent",
    anchor_path: str = "src/client.ts",
    label: str = "createClient",
) -> Path:
    workset = project_root / ".noemaloom" / "workset"
    workset.mkdir(parents=True)
    manifest = {
        "version": 1,
        "projectRootHash": "test",
        "counters": {
            "projectActivitySeq": 1,
            "navigationQuerySeq": 1,
            "anchorInjectionSeq": 0,
            "readWriteSeq": 0,
        },
        "budgets": {
            "injectionDefaultAnchors": 3,
            "injectionDefaultChars": 650,
        },
        "options": {"navigation": {"enabled": enabled, "mode": mode}},
        "anchors": [
            {
                "id": "nav-one",
                "path": anchor_path,
                "label": label,
                "kind": "code.function",
                "role": "source_file",
                "startLine": 10,
                "endLine": 18,
                "state": "active",
                "pinned": True,
                "score": 100,
                "reason": "owner seam",
                "usefulHitCount": 0,
                "ignoredInjectionCount": 0,
                "lastSeenSeq": 1,
            }
        ],
        "tombstones": [],
    }
    path = workset / "anchors.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def test_pre_llm_hook_is_silent_without_project_workset(tmp_path):
    assert pre_llm_call({"projectPath": str(tmp_path)}) == {"context": ""}


def test_pre_llm_hook_requires_explicit_enabled_inject_mode(tmp_path):
    write_manifest(tmp_path, enabled=False, mode="silent")
    assert pre_llm_call({"projectPath": str(tmp_path)}) == {"context": ""}

    manifest_path = tmp_path / ".noemaloom" / "workset" / "anchors.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["options"]["navigation"] = {"enabled": True, "mode": "inject"}
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = pre_llm_call({"projectPath": str(tmp_path)})
    assert "NoemaLoom navigation anchors" in result["context"]
    assert "src/client.ts:10-18" in result["context"]
    assert len(result["context"]) < 650


def test_pre_llm_hook_selects_new_nearest_manifest_after_outer_root_was_cached(tmp_path):
    outer = tmp_path / "outer"
    nested = outer / "packages" / "app"
    nested.mkdir(parents=True)
    write_manifest(outer, enabled=True, mode="inject", anchor_path="outer.ts", label="outerAnchor")

    first = pre_llm_call({"projectPath": str(nested / "src" / "client.ts")})
    assert "outer.ts:10-18" in first["context"]

    write_manifest(nested, enabled=True, mode="inject", anchor_path="nested.ts", label="nestedAnchor")
    second = pre_llm_call({"projectPath": str(nested / "src" / "client.ts")})

    assert "nested.ts:10-18" in second["context"]
    assert "outer.ts:10-18" not in second["context"]


def test_post_tool_call_marks_matching_anchor_useful(tmp_path):
    manifest_path = write_manifest(tmp_path, enabled=True, mode="inject")

    result = post_tool_call({
        "projectPath": str(tmp_path),
        "tool_name": "read_file",
        "args": {"path": "src/client.ts"},
    })

    assert result == {"ok": True}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    anchor = manifest["anchors"][0]
    assert manifest["counters"]["readWriteSeq"] == 1
    assert anchor["usefulHitCount"] == 1
    assert anchor["ignoredInjectionCount"] == 0
    assert anchor["state"] == "active"
    assert not _manifest_lock_path(tmp_path).exists()
    assert list((tmp_path / ".noemaloom" / "workset").glob(".*.tmp")) == []


def test_post_tool_call_skips_update_when_manifest_lock_is_active(tmp_path):
    manifest_path = write_manifest(tmp_path, enabled=True, mode="inject")
    lock_path = _manifest_lock_path(tmp_path)
    lock_path.write_text("active\n", encoding="utf-8")

    result = post_tool_call({
        "projectPath": str(tmp_path),
        "tool_name": "read_file",
        "args": {"path": "src/client.ts"},
    })

    assert result == {"ok": True}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["anchors"][0]["usefulHitCount"] == 0


def test_post_tool_call_recovers_stale_manifest_lock(tmp_path):
    manifest_path = write_manifest(tmp_path, enabled=True, mode="inject")
    lock_path = _manifest_lock_path(tmp_path)
    lock_path.write_text("stale\n", encoding="utf-8")
    old = 1
    os.utime(lock_path, (old, old))

    result = post_tool_call({
        "projectPath": str(tmp_path),
        "tool_name": "read_file",
        "args": {"path": "src/client.ts"},
    })

    assert result == {"ok": True}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["anchors"][0]["usefulHitCount"] == 1
    assert not lock_path.exists()


def test_register_adds_tools_skills_and_optional_hooks():
    class FakeCtx:
        def __init__(self):
            self.tools = {}
            self.skills = {}
            self.hooks = {}

        def register_tool(self, **kwargs):
            self.tools[kwargs["name"]] = kwargs

        def register_skill(self, name, path, description=""):
            self.skills[name] = {"path": path, "description": description}

        def register_hook(self, name, handler):
            self.hooks[name] = handler

    ctx = FakeCtx()
    register(ctx)

    assert set(ctx.tools) == {
        "nl_status",
        "nl_refresh",
        "nl_prepare_context",
        "nl_plan_change",
        "nl_verify_task",
        "nl_anchor_manage",
    }
    assert "nl_anchor_status" not in ctx.tools
    assert "nl_anchor_checkpoint" not in ctx.tools
    assert "usage" in ctx.skills
    assert {"pre_llm_call", "post_tool_call"}.issubset(ctx.hooks)

"""Runtime bridge from Hermes-native tools to the local NoemaLoom stdio server.

The Hermes plugin exposes curated native tool names. Internally, each handler
starts a short-lived NoemaLoom stdio process and calls the matching server tool.
Users do not need to add a separate Hermes MCP server entry.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
from typing import Any

try:  # Hermes ships MCP support; keep an explicit error if the optional SDK is absent.
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
except Exception as exc:  # pragma: no cover - exercised in environments without MCP SDK
    ClientSession = None  # type: ignore[assignment]
    StdioServerParameters = None  # type: ignore[assignment]
    stdio_client = None  # type: ignore[assignment]
    _MCP_IMPORT_ERROR: Exception | None = exc
else:
    _MCP_IMPORT_ERROR = None

_BUILD_LOCK = threading.Lock()
_BUILD_DIR_NAME = ".noemaloom-hermes-build"


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def _format_exception(exc: BaseException, *, depth: int = 0) -> str:
    if depth > 4:
        return "nested exception omitted"
    parts = [f"{type(exc).__name__}: {exc}"]
    nested = getattr(exc, "exceptions", None)
    if nested:
        for index, inner in enumerate(nested):
            if isinstance(inner, BaseException):
                parts.append(f"[{index}] {_format_exception(inner, depth=depth + 1)}")
            else:
                parts.append(f"[{index}] {inner}")
    cause = getattr(exc, "__cause__", None)
    if isinstance(cause, BaseException):
        parts.append(f"caused by {_format_exception(cause, depth=depth + 1)}")
    context = getattr(exc, "__context__", None)
    if isinstance(context, BaseException) and context is not cause:
        parts.append(f"context {_format_exception(context, depth=depth + 1)}")
    return "; ".join(parts)


def _error_envelope(tool: str, message: str, *, project_root: str | None = None, code: str = "noemaloom_plugin_error") -> str:
    root = str(Path(project_root or os.getcwd()).resolve())
    return _json(
        {
            "ok": False,
            "tool": tool,
            "projectRoot": root,
            "graphRevision": None,
            "graphState": "error",
            "tokenBudget": {"requested": 0, "used": 0, "truncated": False},
            "warnings": [{"code": code, "severity": "error", "message": message}],
            "data": {"status": code},
            "evidence": [],
            "nextActions": ["fix NoemaLoom plugin/runtime setup, then retry the same tool"],
        }
    )


def _repo_marker(path: Path) -> bool:
    return (
        (path / "package.json").exists()
        and (path / "packages" / "core" / "src" / "cli" / "main.ts").exists()
        and (path / "python" / "nl_rpg_projection_worker").exists()
    )


def resolve_repo_root() -> Path:
    env_repo = os.environ.get("NOEMALOOM_REPO")
    if env_repo:
        candidate = Path(env_repo).expanduser().resolve()
        if _repo_marker(candidate):
            return candidate
        raise RuntimeError(f"NOEMALOOM_REPO does not point at a valid NoemaLoom checkout: {candidate}")

    here = Path(__file__).resolve()
    for parent in here.parents:
        if _repo_marker(parent):
            return parent
    raise RuntimeError(
        "Cannot find the NoemaLoom repository. Install the plugin as a symlink from "
        "<repo>/hermes-plugin/noemaloom or set NOEMALOOM_REPO=/path/to/NoemaLoom."
    )


def _source_mtime(repo: Path) -> float:
    newest = 0.0
    for base in [repo / "packages" / "core" / "src"]:
        for path in base.rglob("*.ts"):
            newest = max(newest, path.stat().st_mtime)
    migration = repo / "packages" / "core" / "src" / "spans" / "migrations" / "001_initial.sql"
    if migration.exists():
        newest = max(newest, migration.stat().st_mtime)
    return newest


def _find_tsc(repo: Path) -> str:
    local_tsc = repo / "node_modules" / ".bin" / "tsc"
    if local_tsc.exists():
        return str(local_tsc)
    global_tsc = shutil.which("tsc")
    if global_tsc:
        return global_tsc
    raise RuntimeError(
        "TypeScript compiler not found. Run `npm ci --include=dev` in the NoemaLoom repository, "
        "or make `tsc` available on PATH."
    )


def ensure_runtime_build(repo: Path) -> Path:
    build_dir = Path(os.environ.get("NOEMALOOM_BUILD_DIR", repo / _BUILD_DIR_NAME)).expanduser().resolve()
    main_js = build_dir / "cli" / "main.js"
    migration_out = build_dir / "spans" / "migrations" / "001_initial.sql"
    source_mtime = _source_mtime(repo)

    if main_js.exists() and migration_out.exists() and main_js.stat().st_mtime >= source_mtime:
        return build_dir

    with _BUILD_LOCK:
        if main_js.exists() and migration_out.exists() and main_js.stat().st_mtime >= source_mtime:
            return build_dir
        tsc = _find_tsc(repo)
        build_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            tsc,
            "--module", "NodeNext",
            "--moduleResolution", "NodeNext",
            "--target", "ES2022",
            "--strict",
            "--esModuleInterop",
            "--forceConsistentCasingInFileNames",
            "--skipLibCheck",
            "--types", "node",
            "--outDir", str(build_dir),
            "--rootDir", "packages/core/src",
            "packages/core/src/cli/main.ts",
        ]
        result = subprocess.run(
            cmd,
            cwd=str(repo),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=int(os.environ.get("NOEMALOOM_BUILD_TIMEOUT", "120")),
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "TypeScript build failed").strip()
            raise RuntimeError(f"NoemaLoom TypeScript build failed: {detail[:4000]}")
        migration_src = repo / "packages" / "core" / "src" / "spans" / "migrations" / "001_initial.sql"
        migration_out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(migration_src, migration_out)
        return build_dir


def _project_cwd(args: dict[str, Any]) -> str:
    project = args.get("projectPath")
    if isinstance(project, str) and project and project != "default_current_project":
        return str(Path(project).expanduser().resolve())
    return os.getcwd()


def _runtime_env(repo: Path) -> dict[str, str]:
    env = dict(os.environ)
    worker_root = str(repo / "python" / "nl_rpg_projection_worker")
    existing_pythonpath = env.get("PYTHONPATH")
    env["NOEMALOOM_PYTHONPATH"] = worker_root
    env["PYTHONPATH"] = worker_root if not existing_pythonpath else f"{worker_root}{os.pathsep}{existing_pythonpath}"
    env.setdefault("PYTHON", shutil.which("python3") or "python3")
    return env


def _run_async(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: dict[str, Any] = {}

    def runner() -> None:
        try:
            result["value"] = asyncio.run(coro)
        except BaseException as exc:  # pragma: no cover - defensive cross-thread propagation
            result["error"] = exc

    thread = threading.Thread(target=runner, name="noemaloom-mcp-call", daemon=True)
    thread.start()
    thread.join()
    if "error" in result:
        raise result["error"]
    return result.get("value")


async def _call_tool_async(tool: str, args: dict[str, Any], timeout: float) -> str:
    if _MCP_IMPORT_ERROR is not None or ClientSession is None or StdioServerParameters is None or stdio_client is None:
        raise RuntimeError(f"Python MCP SDK is not available: {_MCP_IMPORT_ERROR}")

    repo = resolve_repo_root()
    build_dir = ensure_runtime_build(repo)
    project_cwd = _project_cwd(args)
    params = StdioServerParameters(
        command="node",
        args=[str(build_dir / "cli" / "main.js"), "serve", "--mcp"],
        env=_runtime_env(repo),
        cwd=project_cwd,
    )
    with open(os.devnull, "w", encoding="utf-8") as errlog:
        async with stdio_client(params, errlog=errlog) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await asyncio.wait_for(session.initialize(), timeout=timeout)
                result = await asyncio.wait_for(session.call_tool(tool, arguments=args), timeout=timeout)

    if getattr(result, "isError", False):
        parts = [getattr(block, "text", "") for block in (getattr(result, "content", None) or [])]
        raise RuntimeError("".join(parts).strip() or "NoemaLoom server returned an error")

    text_parts = [getattr(block, "text", "") for block in (getattr(result, "content", None) or []) if getattr(block, "text", "")]
    text = "\n".join(text_parts).strip()
    if not text:
        raise RuntimeError("NoemaLoom server returned an empty response")
    # The NoemaLoom MCP adapter returns the envelope as a JSON text block. Validate but keep the
    # exact envelope shape for Hermes.
    parsed = json.loads(text)
    return _json(parsed)


def call_noemaloom_tool(tool: str, args: dict[str, Any] | None) -> str:
    payload = dict(args or {})
    project_root = _project_cwd(payload)
    try:
        timeout = float(os.environ.get("NOEMALOOM_TOOL_TIMEOUT", "120"))
        return _run_async(_call_tool_async(tool, payload, timeout))
    except Exception as exc:
        return _error_envelope(tool, _format_exception(exc), project_root=project_root)


def make_handler(tool: str):
    def handler(args: dict[str, Any] | None = None, **kwargs) -> str:
        del kwargs
        return call_noemaloom_tool(tool, args)

    return handler

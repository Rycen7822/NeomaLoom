"""Runtime bridge from Hermes-native tools to the local NoemaLoom stdio server.

The Hermes plugin exposes curated native tool names. Internally, each handler
starts a short-lived NoemaLoom stdio process and calls the matching server tool.
Users do not need to add a separate Hermes MCP server entry.
"""

from __future__ import annotations

import asyncio
import hashlib
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
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


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


def _contains_timeout(exc: BaseException, *, depth: int = 0) -> bool:
    if depth > 8:
        return False
    if isinstance(exc, TimeoutError):
        return True
    nested = getattr(exc, "exceptions", None)
    if nested and any(isinstance(inner, BaseException) and _contains_timeout(inner, depth=depth + 1) for inner in nested):
        return True
    cause = getattr(exc, "__cause__", None)
    if isinstance(cause, BaseException) and _contains_timeout(cause, depth=depth + 1):
        return True
    context = getattr(exc, "__context__", None)
    return isinstance(context, BaseException) and _contains_timeout(context, depth=depth + 1)


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


def _timeout_envelope(tool: str, timeout: float, *, project_root: str | None = None) -> str:
    return _error_envelope(
        tool,
        f"NoemaLoom tool timed out after {timeout:g}s; the per-call MCP subprocess was closed by the stdio client cleanup path.",
        project_root=project_root,
        code="noemaloom_tool_timeout",
    )


def _repo_marker(path: Path) -> bool:
    return (
        (path / "package.json").exists()
        and (path / "packages" / "core" / "src" / "cli" / "main.ts").exists()
        and (path / "python" / "nl_rpg_projection_worker").exists()
    )


def _install_metadata_path() -> Path:
    return Path(__file__).resolve().parent / "INSTALL_METADATA.json"


def _plugin_root() -> Path:
    return Path(__file__).resolve().parent


def _read_install_metadata() -> dict[str, Any]:
    metadata_path = _install_metadata_path()
    if not metadata_path.exists():
        return {}
    try:
        loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _git_output(repo: Path, args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def _git_head(repo: Path) -> str | None:
    return _git_output(repo, ["rev-parse", "HEAD"])


def _git_dirty_count(repo: Path) -> int | None:
    output = _git_output(repo, ["status", "--porcelain"])
    if output is None:
        return None
    return len([line for line in output.splitlines() if line.strip()])


def _sha256_file(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except Exception:
        return None


def _provenance_warnings(repo: Path) -> list[dict[str, str]]:
    metadata = _read_install_metadata()
    if not metadata:
        return []
    warnings: list[dict[str, str]] = []
    head = _git_head(repo)
    if head and metadata.get("commit") and metadata.get("commit") != head:
        warnings.append(
            {
                "code": "installed_plugin_source_mismatch",
                "severity": "warning",
                "message": f"Installed NoemaLoom metadata commit {metadata.get('commit')} differs from source HEAD {head}; rerun scripts/sync-hermes-plugin.py.",
            }
        )
    dirty = _git_dirty_count(repo)
    if dirty is not None and metadata.get("dirtyFiles") is not None and int(metadata.get("dirtyFiles") or 0) != dirty:
        warnings.append(
            {
                "code": "installed_plugin_dirty_count_mismatch",
                "severity": "warning",
                "message": f"Installed NoemaLoom metadata dirtyFiles={metadata.get('dirtyFiles')} differs from source dirtyFiles={dirty}; rerun scripts/sync-hermes-plugin.py.",
            }
        )
    schema_hash = _sha256_file(_plugin_root() / "schemas.py")
    if schema_hash and metadata.get("schemaSha256") and metadata.get("schemaSha256") != schema_hash:
        warnings.append(
            {
                "code": "installed_plugin_schema_hash_mismatch",
                "severity": "warning",
                "message": "Installed NoemaLoom schema hash differs from current plugin schemas.py; rerun scripts/sync-hermes-plugin.py.",
            }
        )
    build_hash = _sha256_file(_default_build_dir(repo) / "cli" / "main.js")
    if build_hash and metadata.get("buildMainSha256") and metadata.get("buildMainSha256") != build_hash:
        warnings.append(
            {
                "code": "installed_plugin_build_hash_mismatch",
                "severity": "warning",
                "message": "Installed NoemaLoom build hash differs from current runtime build; rerun scripts/sync-hermes-plugin.py.",
            }
        )
    return warnings


def resolve_repo_root() -> Path:
    env_repo = os.environ.get("NOEMALOOM_REPO")
    if env_repo:
        candidate = Path(env_repo).expanduser().resolve()
        if _repo_marker(candidate):
            return candidate
        raise RuntimeError(f"NOEMALOOM_REPO does not point at a valid NoemaLoom checkout: {candidate}")

    metadata = _read_install_metadata()
    source = metadata.get("source")
    if isinstance(source, str) and source:
        candidate = Path(source).expanduser().resolve()
        if _repo_marker(candidate):
            return candidate

    here = Path(__file__).resolve()
    for parent in here.parents:
        if _repo_marker(parent):
            return parent
    raise RuntimeError(
        "Cannot find the NoemaLoom repository. Install the plugin as a symlink from "
        "<repo>/hermes-plugin/noemaloom or set NOEMALOOM_REPO=/path/to/NoemaLoom."
    )


def _migration_dir(repo: Path) -> Path:
    return repo / "packages" / "core" / "src" / "spans" / "migrations"


def _migration_sources(repo: Path) -> list[Path]:
    migration_dir = _migration_dir(repo)
    if not migration_dir.exists():
        return []
    return sorted(path for path in migration_dir.glob("*.sql") if path.is_file())


def _runtime_migrations_ready(repo: Path, build_dir: Path) -> bool:
    migrations = _migration_sources(repo)
    if not migrations:
        return False
    output_dir = build_dir / "spans" / "migrations"
    return all((output_dir / migration.name).exists() for migration in migrations)


def _copy_runtime_migrations(repo: Path, build_dir: Path) -> None:
    output_dir = build_dir / "spans" / "migrations"
    output_dir.mkdir(parents=True, exist_ok=True)
    for stale in output_dir.glob("*.sql"):
        stale.unlink()
    for migration in _migration_sources(repo):
        shutil.copy2(migration, output_dir / migration.name)


def _source_mtime(repo: Path) -> float:
    newest = 0.0
    for base in [repo / "packages" / "core" / "src"]:
        for path in base.rglob("*.ts"):
            newest = max(newest, path.stat().st_mtime)
    for migration in _migration_sources(repo):
        newest = max(newest, migration.stat().st_mtime)
    return newest


def _default_build_dir(repo: Path) -> Path:
    metadata = _read_install_metadata()
    if metadata.get("installMode") == "copy":
        return _plugin_root() / _BUILD_DIR_NAME
    return repo / _BUILD_DIR_NAME


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


def _ensure_build_runtime_layout(repo: Path, build_dir: Path) -> None:
    """Make an out-of-tree emitted ESM build resolve package metadata and deps."""
    package_json = build_dir / "package.json"
    package_json.write_text('{"type":"module"}\n', encoding="utf-8")
    source_node_modules = repo / "node_modules"
    if not source_node_modules.exists():
        return
    build_node_modules = build_dir / "node_modules"
    if build_node_modules.is_symlink() and build_node_modules.resolve() == source_node_modules.resolve():
        return
    if build_node_modules.exists() or build_node_modules.is_symlink():
        if build_node_modules.is_dir() and not build_node_modules.is_symlink():
            shutil.rmtree(build_node_modules)
        else:
            build_node_modules.unlink()
    build_node_modules.symlink_to(source_node_modules, target_is_directory=True)


def ensure_runtime_build(repo: Path) -> Path:
    build_dir = Path(os.environ.get("NOEMALOOM_BUILD_DIR", _default_build_dir(repo))).expanduser().resolve()
    main_js = build_dir / "cli" / "main.js"
    source_mtime = _source_mtime(repo)
    migrations_ready = _runtime_migrations_ready(repo, build_dir)

    if main_js.exists() and migrations_ready and main_js.stat().st_mtime >= source_mtime:
        _ensure_build_runtime_layout(repo, build_dir)
        return build_dir

    with _BUILD_LOCK:
        migrations_ready = _runtime_migrations_ready(repo, build_dir)
        if main_js.exists() and migrations_ready and main_js.stat().st_mtime >= source_mtime:
            _ensure_build_runtime_layout(repo, build_dir)
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
            timeout=_build_timeout_seconds(),
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "TypeScript build failed").strip()
            raise RuntimeError(f"NoemaLoom TypeScript build failed: {detail[:4000]}")
        _copy_runtime_migrations(repo, build_dir)
        _ensure_build_runtime_layout(repo, build_dir)
        return build_dir


def _is_relative_to(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _runtime_metadata(repo: Path, build_dir: Path) -> dict[str, Any]:
    metadata = _read_install_metadata()
    plugin_root = _plugin_root().resolve()
    resolved_build = build_dir.resolve()
    return {
        "pluginRoot": str(plugin_root),
        "sourceRoot": str(repo.resolve()),
        "buildRoot": str(resolved_build),
        "buildRootInsidePlugin": _is_relative_to(resolved_build, plugin_root),
        "installMode": metadata.get("installMode"),
        "metadataCommit": metadata.get("commit"),
    }


def _allowed_project_roots() -> list[Path]:
    return [Path(value).expanduser().resolve() for value in os.environ.get("NOEMALOOM_ALLOWED_PROJECTS", "").split(os.pathsep) if value.strip()]


def _assert_allowed_project_cwd(project_cwd: Path) -> None:
    allowed_roots = _allowed_project_roots()
    if allowed_roots and not any(_is_relative_to(project_cwd, allowed) for allowed in allowed_roots):
        raise RuntimeError(
            f"projectPath is outside NOEMALOOM_ALLOWED_PROJECTS: {project_cwd}"
        )


def _project_cwd(args: dict[str, Any]) -> str:
    project = args.get("projectPath")
    if isinstance(project, str) and project and project != "default_current_project":
        resolved = Path(project).expanduser().resolve()
        _assert_allowed_project_cwd(resolved)
        return str(resolved)
    resolved = Path(os.getcwd()).resolve()
    _assert_allowed_project_cwd(resolved)
    return str(resolved)


def _runtime_env(repo: Path) -> dict[str, str]:
    allowed = {
        "PATH",
        "HOME",
        "USER",
        "USERNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "SHELL",
        "SYSTEMROOT",
        "WINDIR",
    }
    env = {key: value for key, value in os.environ.items() if key in allowed or key.startswith("NOEMALOOM_")}
    worker_root = str(repo / "python" / "nl_rpg_projection_worker")
    env["NOEMALOOM_PYTHONPATH"] = worker_root
    env["PYTHONPATH"] = worker_root
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
    provenance_warnings = _provenance_warnings(repo)
    if provenance_warnings:
        parsed.setdefault("warnings", [])
        if isinstance(parsed["warnings"], list):
            parsed["warnings"].extend(provenance_warnings)
    parsed.setdefault("data", {})
    if isinstance(parsed["data"], dict):
        parsed["data"].setdefault("runtime", _runtime_metadata(repo, build_dir))
    return _json(parsed)


def _build_timeout_seconds() -> float:
    raw = os.environ.get("NOEMALOOM_BUILD_TIMEOUT", "120")
    try:
        timeout = float(raw)
    except (TypeError, ValueError):
        return 120.0
    return timeout if timeout > 0 else 120.0


def _tool_timeout_seconds() -> float:
    raw = os.environ.get("NOEMALOOM_TOOL_TIMEOUT", "600")
    try:
        timeout = float(raw)
    except (TypeError, ValueError):
        return 600.0
    return timeout if timeout > 0 else 600.0


def call_noemaloom_tool(tool: str, args: dict[str, Any] | None) -> str:
    payload = dict(args or {})
    project_root = _project_cwd(payload)
    timeout = _tool_timeout_seconds()
    try:
        return _run_async(_call_tool_async(tool, payload, timeout))
    except TimeoutError:
        return _timeout_envelope(tool, timeout, project_root=project_root)
    except Exception as exc:
        if _contains_timeout(exc):
            return _timeout_envelope(tool, timeout, project_root=project_root)
        return _error_envelope(tool, _format_exception(exc), project_root=project_root)


def make_handler(tool: str):
    def handler(args: dict[str, Any] | None = None, **kwargs) -> str:
        del kwargs
        return call_noemaloom_tool(tool, args)

    return handler

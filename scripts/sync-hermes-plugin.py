#!/usr/bin/env python3
"""Synchronize the NoemaLoom Hermes plugin and write install provenance metadata.

This is the canonical copy/symlink installer for the standalone Hermes plugin.
It avoids stale INSTALL_METADATA.json records after source commits.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone


def run_git(source: Path, *args: str) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(source), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def dirty_count(source: Path) -> int:
    output = run_git(source, "status", "--porcelain")
    if output is None:
        return -1
    return len([line for line in output.splitlines() if line.strip()])


def sha256_file(path: Path) -> str | None:
    if not path.exists() or not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_dest(profile: str) -> Path:
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()
    if profile == "default":
        return hermes_home / "plugins" / "noemaloom"
    return hermes_home / "profiles" / profile / "plugins" / "noemaloom"


def validate_source(source: Path) -> None:
    required = [
        source / "package.json",
        source / "packages" / "core" / "src" / "cli" / "main.ts",
        source / "hermes-plugin" / "noemaloom" / "noemaloom_bridge.py",
        source / "python" / "nl_rpg_projection_worker",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise SystemExit(f"Not a NoemaLoom checkout, missing: {', '.join(missing)}")


def backup_existing(dest: Path) -> Path | None:
    if not dest.exists() and not dest.is_symlink():
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_root = dest.parent / "noemaloom-backups"
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = backup_root / f"pre-sync-{stamp}"
    shutil.move(str(dest), str(backup))
    return backup


def copy_plugin(source: Path, dest: Path) -> None:
    plugin_src = source / "hermes-plugin" / "noemaloom"
    shutil.copytree(
        plugin_src,
        dest,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache"),
    )


def copy_runtime_migrations(source: Path, build_dest: Path) -> None:
    migration_src = source / "packages" / "core" / "src" / "spans" / "migrations"
    if not migration_src.exists():
        return
    migration_dest = build_dest / "spans" / "migrations"
    migration_dest.mkdir(parents=True, exist_ok=True)
    for stale in migration_dest.glob("*.sql"):
        stale.unlink()
    for migration in sorted(migration_src.glob("*.sql")):
        if migration.is_file():
            shutil.copy2(migration, migration_dest / migration.name)


def copy_runtime_build_if_present(source: Path, dest: Path) -> None:
    build_src = source / ".noemaloom-hermes-build"
    if not (build_src / "cli" / "main.js").exists():
        return
    build_dest = dest / ".noemaloom-hermes-build"
    if build_dest.exists():
        shutil.rmtree(build_dest)
    shutil.copytree(build_src, build_dest, symlinks=True, ignore=shutil.ignore_patterns("*.map", "node_modules"))
    copy_runtime_migrations(source, build_dest)


def symlink_plugin(source: Path, dest: Path) -> None:
    plugin_src = source / "hermes-plugin" / "noemaloom"
    dest.symlink_to(plugin_src, target_is_directory=True)


def absolute_without_following_final(path: Path) -> Path:
    """Return an absolute destination path without resolving an existing symlink target."""
    expanded = path.expanduser()
    if expanded.is_absolute():
        return expanded
    return Path.cwd() / expanded


def assert_safe_existing_dest(source: Path, dest: Path) -> None:
    """Prevent --replace/--backup from deleting or moving the source plugin directory itself."""
    plugin_src = (source / "hermes-plugin" / "noemaloom").resolve()
    if dest.is_symlink():
        return
    try:
        dest_real = dest.resolve()
    except FileNotFoundError:
        return
    if dest_real == plugin_src:
        raise SystemExit(f"Refusing to modify source plugin directory as destination: {dest}")


def write_metadata(source: Path, dest: Path, mode: str, profile: str, backup: Path | None) -> dict[str, object]:
    build_main = (dest if mode == "copy" else source) / ".noemaloom-hermes-build" / "cli" / "main.js"
    schema_file = dest / "schemas.py"
    metadata: dict[str, object] = {
        "source": str(source),
        "commit": run_git(source, "rev-parse", "HEAD"),
        "dirtyFiles": dirty_count(source),
        "installedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "profile": profile,
        "installMode": mode,
        "sourceStatus": run_git(source, "status", "--short", "--branch"),
        "buildMainSha256": sha256_file(build_main),
        "schemaSha256": sha256_file(schema_file),
        "backup": str(backup) if backup else None,
    }
    metadata_path = dest / "INSTALL_METADATA.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return metadata


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync the NoemaLoom Hermes plugin and provenance metadata")
    parser.add_argument("--source", default=str(Path(__file__).resolve().parents[1]), help="NoemaLoom repository root")
    parser.add_argument("--dest", help="Plugin destination; defaults to the selected Hermes profile")
    parser.add_argument("--profile", default="default", help="Hermes profile name for default destination resolution")
    parser.add_argument("--mode", choices=["copy", "symlink"], default="copy")
    parser.add_argument("--backup", action="store_true", help="Move an existing destination into noemaloom-backups before syncing")
    parser.add_argument("--replace", action="store_true", help="Delete an existing destination instead of requiring --backup")
    args = parser.parse_args(argv)

    source = Path(args.source).expanduser().resolve()
    dest = absolute_without_following_final(Path(args.dest)) if args.dest else absolute_without_following_final(default_dest(args.profile))
    validate_source(source)

    if dest.exists() or dest.is_symlink():
        assert_safe_existing_dest(source, dest)
        if args.backup:
            backup = backup_existing(dest)
        elif args.replace:
            if dest.is_symlink() or dest.is_file():
                dest.unlink()
            else:
                shutil.rmtree(dest)
            backup = None
        else:
            raise SystemExit(f"Destination exists: {dest}. Use --backup or --replace.")
    else:
        backup = None

    dest.parent.mkdir(parents=True, exist_ok=True)
    if args.mode == "copy":
        copy_plugin(source, dest)
        copy_runtime_build_if_present(source, dest)
    else:
        symlink_plugin(source, dest)
    metadata = write_metadata(source, dest, args.mode, args.profile, backup)
    print(json.dumps({"ok": True, "dest": str(dest), "metadata": metadata}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

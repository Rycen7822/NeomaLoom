import importlib.util
import json
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "sync-hermes-plugin.py"


def load_sync_module():
    spec = importlib.util.spec_from_file_location("sync_hermes_plugin", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_source(root: Path) -> Path:
    source = root / "source"
    plugin_dir = source / "hermes-plugin" / "noemaloom"
    (source / "packages" / "core" / "src" / "cli").mkdir(parents=True)
    (source / "python" / "nl_rpg_projection_worker").mkdir(parents=True)
    plugin_dir.mkdir(parents=True)
    (source / "package.json").write_text('{"name":"fake-noemaloom"}\n', encoding="utf-8")
    (source / "packages" / "core" / "src" / "cli" / "main.ts").write_text("export {};\n", encoding="utf-8")
    (plugin_dir / "noemaloom_bridge.py").write_text("# bridge\n", encoding="utf-8")
    (plugin_dir / "schemas.py").write_text("SCHEMA = {}\n", encoding="utf-8")
    return source


def test_symlink_replace_unlinks_destination_symlink_without_deleting_source_plugin(tmp_path):
    module = load_sync_module()
    source = make_source(tmp_path)
    source_plugin = source / "hermes-plugin" / "noemaloom"
    dest = tmp_path / "hermes" / "plugins" / "noemaloom"
    dest.parent.mkdir(parents=True)
    dest.symlink_to(source_plugin, target_is_directory=True)

    rc = module.main([
        "--source",
        str(source),
        "--dest",
        str(dest),
        "--mode",
        "symlink",
        "--replace",
    ])

    assert rc == 0
    assert dest.is_symlink()
    assert dest.resolve() == source_plugin.resolve()
    assert (source_plugin / "noemaloom_bridge.py").exists()
    metadata = json.loads((source_plugin / "INSTALL_METADATA.json").read_text(encoding="utf-8"))
    assert metadata["source"] == str(source.resolve())
    assert metadata["installMode"] == "symlink"


def test_replace_refuses_to_delete_source_plugin_directory(tmp_path):
    module = load_sync_module()
    source = make_source(tmp_path)
    source_plugin = source / "hermes-plugin" / "noemaloom"

    with pytest.raises(SystemExit, match="Refusing to modify source plugin directory"):
        module.main([
            "--source",
            str(source),
            "--dest",
            str(source_plugin),
            "--mode",
            "copy",
            "--replace",
        ])

    assert (source_plugin / "noemaloom_bridge.py").exists()

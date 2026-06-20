# NoemaLoom

English | [中文](README.zh-CN.md)

NoemaLoom is a local span-first repository modification localization runtime. It builds derived indexes under `.noemaloom/`, gives coding agents a compact read-only view of the repository, and helps them prepare context, plan impact, and verify coverage after changes.

NoemaLoom does not edit source files. It identifies and verifies repository spans; Hermes, Codex, or another agent performs the actual file edits with its native tools.

For Hermes, the recommended integration is now the native plugin in `hermes-plugin/noemaloom`. The manual MCP server remains available for Codex or other MCP-only clients.

## What It Provides

- Repository-wide span indexing for source code, Markdown/MDX/RST documents, config files, package metadata, tests, examples, and feature projection data.
- Cross-surface links between code, docs, config, tests, examples, and features.
- Context preparation with ranked targets, paths, line ranges, decisions, reasons, confidence, and evidence.
- Optional top-span reads with relocation support when line numbers drift.
- Impact planning and coverage verification for old terms, links, anchors, unsynced docs, and code-doc mismatches.
- Context recovery from a derived repository map without re-reading the whole repository.

## Safety Model

NoemaLoom writes only project-local derived state under `.noemaloom/`.

It does not write global config, does not install Git hooks, does not patch Codex cache, does not expose writer tools, and does not expose raw backend tool surfaces. The derived cache can be deleted and rebuilt from repository content.

## Agent-Facing Tools

The Hermes plugin and MCP server expose these curated agent-facing tools:

- `nl_status`
- `nl_refresh`
- `nl_prepare_context`
- `nl_plan_change`
- `nl_verify_task`
- `nl_anchor_status`
- `nl_anchor_promote`
- `nl_anchor_demote`
- `nl_anchor_repair`
- `nl_anchor_retire`
- `nl_anchor_checkpoint`

`nl_refresh` writes derived cache files under `.noemaloom/`. The `nl_anchor_*` tools write only controlled project-local navigation state under `.noemaloom/workset/`. No tool writes project source files.

## Hermes Plugin

Use `hermes-plugin/noemaloom` when Hermes should use NoemaLoom directly as a native plugin. This keeps the Hermes-facing setup in one plugin directory: tool registration, runtime bridge, and bundled usage skill.

No separate Hermes MCP server entry is required for this plugin. The plugin registers the curated tools directly in Hermes and internally starts a short-lived local NoemaLoom stdio process for each tool call.

Development/source-linked install:

```bash
cd <NOEMALOOM_REPO>
npm ci --include=dev
python3 scripts/sync-hermes-plugin.py --mode symlink --replace
hermes plugins enable noemaloom
```

Copy install with provenance metadata:

```bash
cd <NOEMALOOM_REPO>
npm ci --include=dev
python3 scripts/sync-hermes-plugin.py --mode copy --backup
hermes plugins enable noemaloom
```

The sync script writes `INSTALL_METADATA.json` with the source path, Git HEAD, dirty-file count, and build/schema hashes. Fresh plugin calls warn when that metadata no longer matches the source checkout, so rerun the script after source commits or local edits that should be reflected in Hermes.

Start a new Hermes session or restart the gateway after enabling the plugin. When a task needs NoemaLoom workflow guidance, load the bundled skill explicitly:

```python
skill_view(name="noemaloom:usage")
```

Expected Hermes verification:

```bash
hermes plugins list --plain --no-bundled
hermes tools list
```

Then call `nl_status` in the target project before any refresh or localization work.

## Manual MCP Configuration

Use this compatibility path for Codex or other clients that consume stdio MCP servers directly. Hermes users should prefer the native plugin above unless they specifically want NoemaLoom as a separate MCP server.

Make the `noemaloom` command available from this repository workspace, then start the MCP stdio server with:

```bash
noemaloom serve --mcp
```

Hermes MCP server entry:

```yaml
mcp_servers:
  noemaloom:
    command: noemaloom
    args:
      - serve
      - --mcp
    timeout: 120
    connect_timeout: 60
    enabled: true
```

Codex MCP server entry:

```toml
[mcp_servers.noemaloom]
command = "noemaloom"
args = ["serve", "--mcp"]
```

## Agent Installation Prompt

Give this prompt to an agent when you want it to install NoemaLoom from this local source repository:

```text
Install NoemaLoom from the local source repository at <NOEMALOOM_REPO>.

For Hermes, prefer the native plugin at <NOEMALOOM_REPO>/hermes-plugin/noemaloom. Do not add a separate Hermes MCP server entry unless the user explicitly asks for MCP compatibility mode.

First choose the installation scope and keep the two scopes separate.

User-level installation:
- Use this when this user account's Hermes sessions should be able to use NoemaLoom across multiple projects.
- Verify or install Node.js 22.13+ LTS, Node.js 23.4+, or Node.js 24+, Python 3.11+, and npm dependencies in <NOEMALOOM_REPO> with `npm ci --include=dev`.
- Install the plugin with `python3 scripts/sync-hermes-plugin.py --mode symlink --replace` or `python3 scripts/sync-hermes-plugin.py --mode copy --backup`; the script writes `INSTALL_METADATA.json` so fresh plugin calls can warn if installed provenance no longer matches source HEAD.
- Enable the plugin with `hermes plugins enable noemaloom`, start a new session or restart the gateway, and load `skill_view(name="noemaloom:usage")` when workflow guidance is needed.

Project-level installation:
- Use this when the current project should declare that agents must use NoemaLoom, without changing user-wide agent defaults.
- Install the plugin into `<target-project>/.hermes/plugins/noemaloom` and launch Hermes from `<target-project>` with `HERMES_ENABLE_PROJECT_PLUGINS=true`.
- Remember that standalone project plugins still require a `plugins.enabled` allow-list in the active `$HERMES_HOME/config.yaml`, unless the run intentionally uses a project-local `HERMES_HOME`.
- Add project instructions such as an `AGENTS.md` NoemaLoom section that tells agents to load `skill_view(name="noemaloom:usage")` and use only the public curated tools.

Compatibility MCP installation:
- Use this only for Codex or other MCP-only clients.
- Verify or create a user-local way to run the `noemaloom` command from <NOEMALOOM_REPO>. Do not assume a published npm package.
- Add the MCP server entry with command `noemaloom` and args `["serve", "--mcp"]`.

Rules:
- Do not install Git hooks, patch agent caches, expose raw backend tools, or edit unrelated files.
- Before changing any user-level agent config, show the exact target file and diff.
- Verify the result with `hermes plugins list`, a fresh plugin loader smoke, and then call `nl_status` in the target project.
```

## Recommended Agent Workflow

1. Load `skill_view(name="noemaloom:usage")` and the relevant bundled reference workflow.
2. Call `nl_status` to inspect index state and safety flags.
3. Call `nl_refresh` with `target="all"` and `mode="safe"` when indexes are missing or stale.
4. Call `nl_prepare_context` for the task goal.
5. Call `nl_plan_change` before code or API changes.
6. Edit files using the agent's native file-editing tools.
7. Call `nl_verify_task` to catch remaining old terms, broken links, stale anchors, unsynced docs, and mismatches.
8. Call `nl_refresh` with `target="changed"` and `mode="safe"` after coverage passes.

## Development

Requirements:

- Node.js 22.13+ LTS, Node.js 23.4+, or Node.js 24+
- Python 3.11 or newer for the feature projection worker tests
- npm

NoemaLoom uses the built-in `node:sqlite` module for its derived span/codegraph databases. Node.js 20, Node.js 22.12 and earlier, and early Node.js 23 releases do not provide that module, so they are not supported runtimes.

Useful commands:

```bash
npm run build
npm run typecheck
npm test
python -m pytest
```

The Python test configuration is restricted to this repository's `tests/` directory, so ignored reference source trees are not collected by the final Python gate.

## Documentation

- [Architecture](docs/architecture.md)
- [MCP tools](docs/mcp-tools.md)
- [Data model](docs/data-model.md)
- [Indexing](docs/indexing.md)
- [Locating](docs/locating.md)
- [Safety](docs/safety.md)
- [Troubleshooting](docs/troubleshooting.md)

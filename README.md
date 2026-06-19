# NoemaLoom

English | [中文](README.zh-CN.md)

NoemaLoom is a local MCP server for span-first repository modification localization. It builds derived indexes under `.noemaloom/`, gives coding agents a compact read-only view of the repository, and helps them prepare context, plan impact, and verify coverage after changes.

NoemaLoom does not edit source files. It identifies and verifies repository spans; Codex, Hermes, or another agent performs the actual file edits with its native tools.

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

## MCP Tools

The server exposes exactly these five agent-facing tools:

- `nl_status`
- `nl_refresh`
- `nl_prepare_context`
- `nl_plan_change`
- `nl_verify_task`

`nl_refresh` writes derived cache files under `.noemaloom/`. The other tools are read-only with respect to project source files.

## Manual MCP Configuration

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

First choose the installation scope and keep the two scopes separate.

User-level installation:
- Use this when this user account's agent clients should be able to start NoemaLoom across multiple projects.
- Verify or create a user-local way to run the `noemaloom` command from <NOEMALOOM_REPO>. Do not assume a published npm package.
- Add the MCP server entry to the user's agent configuration with the command `noemaloom` and args `["serve", "--mcp"]`.

Project-level installation:
- Use this when the current project should declare that agents must use NoemaLoom, without changing user-wide agent defaults.
- Add project instructions such as an `AGENTS.md` NoemaLoom section that tells agents to read `skill/noemaloom/SKILL.md` and the relevant `skill/noemaloom/references/*.md` workflow.
- If the project has project-scoped MCP configuration, add the same MCP server entry there. Otherwise document the required user-level MCP entry and leave user-level config unchanged.

Rules:
- Do not install Git hooks, patch agent caches, expose raw backend tools, or edit unrelated files.
- Before changing any user-level agent config, show the exact target file and diff.
- Verify the result by running the MCP server command or the agent's MCP health check, then call `nl_status` in the target project.
```

## Recommended Agent Workflow

1. Read `skill/noemaloom/SKILL.md` and the relevant `skill/noemaloom/references/*.md` workflow.
2. Call `nl_status` to inspect index state and safety flags.
3. Call `nl_refresh` with `target="all"` and `mode="safe"` when indexes are missing or stale.
4. Call `nl_prepare_context` for the task goal.
5. Call `nl_plan_change` before code or API changes.
6. Edit files using the agent's native file-editing tools.
7. Call `nl_verify_task` to catch remaining old terms, broken links, stale anchors, unsynced docs, and mismatches.
8. Call `nl_refresh` with `target="changed"` and `mode="safe"` after coverage passes.

## Development

Requirements:

- Node.js 20 or newer
- Python 3.11 or newer for the feature projection worker tests
- npm

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

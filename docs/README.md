# NoemaLoom

NoemaLoom is a local MCP server for repository-wide modification localization. It builds derived indexes under `.noemaloom/`, exposes a compact read-only tool surface, and helps agents prepare context, plan impact, and verify coverage after edits.

## Package

Use the package from this repository workspace during development. Build or link the `noemaloom` command from the local package before adding it to an agent MCP configuration.

Start the MCP server manually:

```bash
noemaloom serve --mcp
```

## Hermes MCP Configuration

Add this server entry manually:

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

## Codex MCP Configuration

Add this server entry manually:

```toml
[mcp_servers.noemaloom]
command = "noemaloom"
args = ["serve", "--mcp"]
```

## AGENTS.md Snippet

```markdown
## NoemaLoom
Use the `noemaloom` MCP server for repository-wide modification localization. Read `skill/noemaloom/SKILL.md` and the relevant `skill/noemaloom/references/*.md` workflow before long-running repository understanding, documentation update, code impact, or multi-file synchronization tasks. NoemaLoom locates and verifies spans; file edits are performed with native Codex tools.
```

## Tools

The agent-facing tools are `nl_status`, `nl_refresh`, `nl_prepare_context`, `nl_plan_change`, and `nl_verify_task`.

NoemaLoom does not write global config, does not install Git hooks, and does not patch Codex cache. It does not expose writer tools or raw backend tools.

## Derived Cache

`.noemaloom/` is a derived index cache. It stores file inventory, spans, graph edges, feature projection data, derived maps, logs, and locks. It can be refreshed from repository files.

## Modification Workflow

1. Read `skill/noemaloom/SKILL.md` and the relevant reference workflow.
2. Call `nl_status`.
3. Call `nl_refresh` when indexes are missing or stale.
4. Call `nl_prepare_context` for target ordering and read ranges.
5. Call `nl_plan_change` before code or API changes.
6. Edit with native Codex or Hermes tools.
7. Call `nl_verify_task`.
8. Call `nl_refresh` with `target="changed"` after coverage passes.

## Troubleshooting

- If indexes are missing, run `nl_refresh` with `target="all"` and `mode="safe"`.
- If a span is stale, rerun `nl_prepare_context` with top-span reads and refresh changed paths after verification.
- If coverage fails, remove remaining old terms, repair links or anchors, sync document roles, and verify linked tests.
- If the feature projection worker is unavailable, NoemaLoom continues with warnings and deterministic indexed spans.

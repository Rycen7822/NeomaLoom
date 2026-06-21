# NoemaLoom Hermes Plugin

This directory is a native Hermes plugin wrapper for the NoemaLoom repository. It registers the six curated `nl_*` tools directly in Hermes and bundles the `noemaloom:usage` operator skill.

## Tools

- `nl_status`
- `nl_refresh`
- `nl_prepare_context`
- `nl_plan_change`
- `nl_verify_task`
- `nl_anchor_manage`

`nl_anchor_manage` supports the default public promote/demote curation path only. Lower-frequency anchor maintenance operations remain CLI-only: use `noemaloom anchor repair`, `noemaloom anchor retire`, or `noemaloom anchor checkpoint` from the source checkout when a human/operator intentionally wants those lifecycle operations.

No separate Hermes MCP server entry is required for this plugin. The plugin starts a short-lived local NoemaLoom stdio process internally for each tool call and returns the normal NoemaLoom envelope.

## Development install

```bash
cd /path/to/NoemaLoom
npm ci --include=dev
python3 scripts/sync-hermes-plugin.py --mode symlink --replace
hermes plugins enable noemaloom
```

For copy installs, use `python3 scripts/sync-hermes-plugin.py --mode copy --backup`. The sync script writes `INSTALL_METADATA.json` with the source checkout, Git HEAD, dirty-file count, and build/schema hashes; fresh bridge calls warn if the installed metadata falls out of sync with the source checkout.

Start a new Hermes session or restart the gateway after enabling the plugin, then load the workflow skill when needed:

```python
skill_view(name="noemaloom:usage")
```

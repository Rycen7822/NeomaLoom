# NoemaLoom Hermes Plugin

This directory is a native Hermes plugin wrapper for the NoemaLoom repository. It registers the five curated `nl_*` tools directly in Hermes and bundles the `noemaloom:usage` operator skill.

## Tools

- `nl_status`
- `nl_refresh`
- `nl_prepare_context`
- `nl_plan_change`
- `nl_verify_task`

No separate Hermes MCP server entry is required for this plugin. The plugin starts a short-lived local NoemaLoom stdio process internally for each tool call and returns the normal NoemaLoom envelope.

## Development install

```bash
cd /path/to/NoemaLoom
npm ci --include=dev
ln -sfn "$PWD/hermes-plugin/noemaloom" "${HERMES_HOME:-$HOME/.hermes}/plugins/noemaloom"
hermes plugins enable noemaloom
```

If the plugin directory is copied instead of symlinked, set `NOEMALOOM_REPO=/path/to/NoemaLoom` before starting Hermes so the plugin can find the TypeScript runtime and Python feature worker package.

Start a new Hermes session or restart the gateway after enabling the plugin, then load the workflow skill when needed:

```python
skill_view(name="noemaloom:usage")
```

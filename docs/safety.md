# Safety

NoemaLoom uses project-local derived state under `.noemaloom/`. It does not write global config, install Git hooks, patch Codex cache, expose writer tools, or expose raw backend tool surfaces.

## Path and write boundaries

- Source files are read-only from NoemaLoom's perspective.
- Derived writes are constrained to the project state directory.
- Refresh writes cache/index files under `.noemaloom/`.
- Navigation-anchor operations write controlled workset state under `.noemaloom/workset/`.
- Symlinked, ignored, generated, and vendor paths are filtered before indexing or verification claims.

## State-file durability

State path guards use no-follow opens where the platform exposes `O_NOFOLLOW`; the runtime reports whether that support is available instead of silently treating unsupported platforms as equivalent. Atomic state writes use temp files and rename. Durable append paths sync after writing so refresh/workset logs do not overstate crash durability.

## Hermes plugin install provenance

Symlink installs use the source checkout directly. Copy installs copy the plugin and runtime build, but still depend on the source checkout for repository assets such as worker code and linked dependencies unless packaging is made fully self-contained. `INSTALL_METADATA.json` records source, commit, dirty-file count, build hash, and schema hash; bridge calls warn when those recorded values drift from the current source/plugin/runtime state.

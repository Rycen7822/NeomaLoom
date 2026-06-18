# Safety

NoemaLoom uses project-local derived state under `.noemaloom/`.

It does not write global config, does not install Git hooks, does not patch Codex cache, does not expose writer tools, and does not expose raw backend tool surfaces.

Path guards keep derived writes inside the project state directory. Symlinked and ignored files are excluded from indexing.

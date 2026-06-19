# markdown_update

Use this for Markdown, MDX, README, tutorial, quickstart, API docs, examples, design docs, and changelog edits.

1. Call `nl_prepare_context` with:
   - `goal`: the exact documentation update.
   - `targetRoles=["canonical_api_doc","readme_doc","quickstart_doc","tutorial_doc","example_doc","design_doc","changelog_doc","source_file","config_file","test_file"]`.
   - `limit=40`.
   - `budget=2048`.
   - `includeSnippets=false`.
   - `readTopSpans=true` when exact Markdown block text is needed before editing.
2. Inspect `canonical_api_doc` targets first, then `readme_doc`, `quickstart_doc`, `tutorial_doc`, `example_doc`, `design_doc`, and `changelog_doc`.
3. Edit complete Markdown blocks only with native Codex or Hermes tools.
4. When the same term or behavior appears in more than one doc file, also read `references/multi_doc_sync.md`.
5. Call `nl_verify_task` with:
   - `goal`: the documentation update.
   - `changedPaths`: every edited Markdown or example path.
   - `oldTerms`: removed or renamed terms, or `[]`.
   - `newTerms`: required replacement terms, or `[]`.
6. Continue only when `nl_verify_task` returns `status="pass"`.
7. Call `nl_refresh` with `target="changed"` and `mode="safe"` after verification passes.

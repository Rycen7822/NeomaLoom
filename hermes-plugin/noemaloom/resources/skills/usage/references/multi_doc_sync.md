# multi_doc_sync

Use this when a documentation task touches multiple doc files, old-term sweeps, examples, README, tutorials, API docs, papers, design docs, or changelogs.

1. Call `nl_prepare_context` with:
   - `goal`: the exact synchronization task.
   - `targetRoles=["canonical_api_doc","readme_doc","quickstart_doc","tutorial_doc","example_doc","paper_doc","design_doc","changelog_doc"]`.
   - `limit=50`.
   - `budget=2048`.
   - `includeSnippets=false`.
   - `readTopSpans=false` unless exact current text is needed before editing.
2. Process returned targets in this order:
   1. `canonical_api_doc`
   2. `readme_doc`
   3. `quickstart_doc`
   4. `tutorial_doc`
   5. `example_doc`
   6. `paper_doc`
   7. `design_doc`
   8. `changelog_doc`
3. Do not stop after the first high-score document. Inspect every returned target whose role is in the ordered list and whose reason matches the task.
4. Edit files only with native Codex or Hermes tools.
5. Call `nl_verify_task` with:
   - `goal`: the exact synchronization task.
   - `changedPaths`: every edited repository-relative path.
   - `oldTerms`: every old term or removed phrase that must disappear.
   - `newTerms`: every required replacement term or phrase.
6. Continue only when `nl_verify_task` returns `status="pass"`.
7. Call `nl_refresh` with `target="changed"` and `mode="safe"` after verification passes.

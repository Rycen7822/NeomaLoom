# markdown_update

1. Call `nl_prepare_context` with document, code, config, example, and feature roles.
2. Inspect `canonical_api_doc` spans first from the prepared context.
3. Inspect README, tutorial, quickstart, and example document spans next.
4. Edit complete Markdown blocks only with native Codex or Hermes tools.
5. Call `nl_verify_task` with changed Markdown paths, old terms, and new terms.
6. Call `nl_refresh` with `target="changed"` only after coverage passes.

# markdown_update

1. Call `nl_locate` with document, code, config, example, and feature roles.
2. Read `canonical_api_doc` spans first with `nl_read_span`.
3. Read README, tutorial, quickstart, and example document spans next.
4. Edit complete Markdown blocks only with native Codex or Hermes tools.
5. Call `nl_verify_coverage` with changed Markdown paths, old terms, and new terms.
6. Call `nl_refresh` with `target="changed"` only after coverage passes.

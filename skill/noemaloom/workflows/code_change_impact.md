# code_change_impact

1. Call `nl_locate` with source, test, config, doc, example, and feature roles.
2. Call `nl_impact` for the symbol or file being changed.
3. Read impacted source, test, config, doc, and example spans.
4. Edit files with native Codex or Hermes tools and run the project test command.
5. Call `nl_verify_coverage` for docs, config, examples, old terms, and new terms.
6. Refresh changed indexes after verification passes.

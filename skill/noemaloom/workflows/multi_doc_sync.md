# multi_doc_sync

Process existing document roles in this order:

1. `canonical_api_doc`
2. `readme_doc`
3. `quickstart_doc`
4. `tutorial_doc`
5. `example_doc`
6. `paper_doc`
7. `design_doc`
8. `changelog_doc`

Do not stop after the first high-score document. Finish only after `nl_verify_coverage` reports pass.

# Indexing

`nl_refresh` builds derived indexes in this order:

1. File inventory.
2. Code fact index.
3. Document spans.
4. Artifact spans.
5. Test and example spans.
6. Feature projection.
7. Projection graph.
8. Cross-reference links.
9. PureLex retrieval core tables (`repo_symbols` and `repo_symbol_aliases`) inside the span database.
10. Derived repository map.
11. Refresh revision and coverage metadata.

The PureLex retrieval core is still local derived state under `.noemaloom/`: no vector database, external search service, neural reranker, or LLM query rewrite is used. Code symbol records are rebuilt from projected spans on every deep refresh, and import aliases are resolved into deterministic alias records when the extractor can prove the target symbol.

Indexed span text and read-span tool output are redacted for supported secret-like patterns. Original file and span hashes continue to be computed from the source text so relocation and verification gates are not weakened by redaction.

`target="changed"` with `mode="safe"` uses the previous inventory snapshot to report changed and deleted paths, then writes a current graph after verification passes.

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
9. Derived repository map.
10. Refresh revision.

`target="changed"` with `mode="safe"` uses the previous inventory snapshot to report changed and deleted paths, then writes a current graph after verification passes.

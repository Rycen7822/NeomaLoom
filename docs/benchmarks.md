# Benchmarks

Benchmark coverage is intentionally fixture-first. NoemaLoom should not tune ranking weights or verifier policy from intuition alone.

Initial fixture manifests live under `benchmarks/fixtures/`:

- locator fixtures define a repository fixture, goal, target roles, and expected top paths for context preparation.
- verifier fixtures define a repository fixture, edit goal, changed paths, old/new terms, and expected verification status.

These manifests are not a full harness yet. They are stable seeds for future benchmark runners and for reviewing whether route splits, schema changes, or verifier policy changes are behavior-preserving.

Rules:

1. Add or update fixture expectations before changing ranking/verifier policy.
2. Do not tune ranking weights in the same patch that moves locator code.
3. Keep benchmark repositories small and checked in under `tests/fixtures/`.
4. Treat benchmark output as evidence for policy changes, not as a replacement for contract tests.

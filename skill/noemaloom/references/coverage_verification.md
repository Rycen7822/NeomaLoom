# coverage_verification

Use this after any file edit and before reporting the task complete.

1. Call `nl_verify_task` with:
   - `goal`: the exact completed task.
   - `changedPaths`: every edited repository-relative path. Do not omit docs, examples, tests, or config files.
   - `oldTerms`: removed or renamed terms, or `[]` when no term was removed.
   - `newTerms`: required replacement terms, or `[]` when no term was introduced.
   - `target`: the changed symbol, file, config key, or feature anchor when one exists.
   - `targetType="auto"` when `target` is supplied.
2. Treat these result arrays as blockers when non-empty: `remainingOldTermHits`, `brokenLinks`, `staleAnchors`, `unsyncedDocRoles`, `codeDocMismatches`, and `unverifiedLinkedTests`.
3. Fix blockers with native Codex or Hermes tools, then rerun `nl_verify_task` with the same `goal`, updated `changedPaths`, and the same term arrays.
4. Continue only when `nl_verify_task` returns `status="pass"`.
5. Call `nl_refresh` with `target="changed"` and `mode="safe"` after verification passes.

# coverage_verification

1. Pass all edited repository paths as `changedPaths`.
2. Pass renamed or removed terms as `oldTerms`.
3. Pass required replacement terms as `newTerms`.
4. Treat remaining old-term hits, broken links, stale anchors, unsynced doc roles, mismatches, and unverified linked tests as blockers.
5. Continue only when `nl_verify_coverage` returns `status="pass"`.

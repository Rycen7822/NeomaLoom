# NAVDAILY6 Long-Term Repair Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Repair the high-priority NoemaLoom daily-use failures recorded in `/home/xu/project/tests/neomaloom/problems.md` by tightening existing owner seams for path ownership, output shaping, CLI contract, and anchor status size.

**Architecture:** The repair changes existing central seams instead of adding parallel wrappers: `path-layer.ts` owns path/business filtering, `ranking.ts` owns target eligibility, `coverage-plan.ts` and `nl-prepare-context.ts` own selected-target coverage, `output-profile.ts` owns compact payload size, and `cli/main.ts`/`nl-anchor.ts` own public CLI and anchor status. Feature projection storage remains available for graph construction, but generated NoemaLoom state is no longer a default user-facing target.

**Design audit:** `tmp/navdaily6-fix-design.md`; the ledger deletes special-case feature-state exposure, recomputes coverage from selected targets, and uses existing responseProfile fields rather than appending new filters or commands.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, NoemaLoom MCP tool handlers, project-local `.noemaloom` state.

---

### Task 1: Lock down path-layer and feature-state target eligibility

**Objective:** Prevent generated NoemaLoom/agent/scratch state from becoming default locator, navigation, or repository-map targets.

**Files:**
- Modify: `packages/core/src/files/path-layer.ts`
- Modify: `packages/core/src/locator/ranking.ts`
- Modify: `packages/core/src/derived-map/repository-map.ts`
- Test: `tests/unit/role-classifier.test.ts`
- Test: `tests/unit/locator-ranking.test.ts`
- Test: `tests/unit/derived-map.test.ts`

**Design refs:** B1-B4, D1-D3, C1.

**Why this is not append-only:** It removes existing exceptions and strengthens the already shared path classifier rather than adding another target sanitizer.

**Step 1: Write failing tests**

Add assertions that:
- `classifyPathLayer('planning_archive/old.md') === 'archive'`.
- `classifyPathLayer('quest001_p0_repair_worktree/src/file.py') === 'scratch'`.
- `classifyPathLayer('.pytest_cache/v/cache/nodeids') === 'artifact'`.
- A `.noemaloom/planning/features.json` `feature.node` candidate is not returned even when `targetRoles: ['feature_plan']`.
- Repository map JSON does not include `.noemaloom/planning/features.json` in canonical docs/core modules/doc surfaces/feature-facing surfaces.

**Step 2: Run tests to verify failure**

Run:

```bash
npm run test -- tests/unit/role-classifier.test.ts tests/unit/locator-ranking.test.ts tests/unit/derived-map.test.ts
```

Expected: FAIL on the newly added assertions before implementation.

**Step 3: Implement minimal change**

- Add the missing generated/scratch/archive path patterns to `path-layer.ts`.
- Change `queryAllowsFeatureCandidate`/feature filtering in `ranking.ts` so generated feature candidates are allowed only when `isDefaultBusinessPath(candidate.path)` is true. Generated `.noemaloom/**` feature nodes stay in DB but are not default targets.
- Remove `feature_plan`/`feature.node` safe exception from repository-map path filtering.

**Step 4: Run tests to verify pass**

Run the same Vitest command. Expected: PASS.

**Step 5: Commit checkpoint if isolated**

```bash
git add packages/core/src/files/path-layer.ts packages/core/src/locator/ranking.ts packages/core/src/derived-map/repository-map.ts tests/unit/role-classifier.test.ts tests/unit/locator-ranking.test.ts tests/unit/derived-map.test.ts
git commit -m "fix: keep generated feature state out of navigation targets"
```

---

### Task 2: Make prepare coverage and readTopSpans use selected-target semantics

**Objective:** Stop parent-root sibling pollution in `coveragePlan` and preserve verification surfaces under small `maxReadSpans` limits.

**Files:**
- Modify: `packages/core/src/mcp/tools/nl-prepare-context.ts`
- Test: `tests/integration/scoped-coverage-tools.test.ts`

**Design refs:** B5-B6, D4-D5.

**Why this is not append-only:** It narrows the existing prepare data flow to selected/routed targets and changes one selector ordering; no new planning mode is introduced.

**Step 1: Write failing tests**

Add integration cases that:
- Create a parent containing `loop/src/client.ts`, `loop/tests/client.test.ts`, and `fseg/docs/client.md`; querying with scope/goal for `loop` returns a `coveragePlan` whose docs/tests are inside `loop/` only.
- With `readTopSpans: true` and `maxReadSpans: 2`, a source target plus an available `verify_only` test/doc target are read instead of two source-only inspect spans.

**Step 2: Run tests to verify failure**

```bash
npm run test -- tests/integration/scoped-coverage-tools.test.ts
```

Expected: FAIL before implementation.

**Step 3: Implement minimal change**

- Import/reuse `buildCoveragePlan` in `nl-prepare-context.ts` if needed and recompute `coveragePlan` from `routedLocated.targets` after exact-route selection.
- Change `selectReadTargets` sort to account for verification/role diversity before duplicate inspect-only sources. Keep deterministic original-order tie-breakers.
- Preserve existing `readSkipReasons` shape.

**Step 4: Run tests to verify pass**

Run the same integration test file. Expected: PASS.

**Step 5: Commit checkpoint if isolated**

```bash
git add packages/core/src/mcp/tools/nl-prepare-context.ts tests/integration/scoped-coverage-tools.test.ts
git commit -m "fix: scope prepare coverage to selected targets"
```

---

### Task 3: Shrink compact prepare and anchor/status output without hiding action-critical data

**Objective:** Make compact/default output meaningfully smaller while keeping paths, line ranges, omissions, warnings, and next actions visible.

**Files:**
- Modify: `packages/core/src/mcp/output-profile.ts`
- Modify: `packages/core/src/mcp/tools/nl-anchor.ts`
- Modify: `packages/core/src/mcp/tools/nl-status.ts` if needed for anchor profile pass-through
- Test: `tests/unit/token-budget.test.ts`
- Test: `tests/unit/anchor-tools.test.ts`
- Test: `tests/integration/scoped-coverage-tools.test.ts`

**Design refs:** B7, B9, D6, D8, C2, C4.

**Why this is not append-only:** It uses the existing profile shaper and existing anchor `responseProfile`; no new compact tool or post-envelope truncator is added.

**Step 1: Write failing tests**

Add assertions that:
- Compact `nl_prepare_context` output uses coverage previews with omitted counts and does not include full read span content beyond a bounded preview.
- Debug profile preserves full read span content.
- `nl_anchor_status` default compact omits full `anchors`, `tombstones`, and full navigation text while reporting counts/previews/omitted counts.
- `nl_anchor_status` with `responseProfile: 'debug'` returns the full status data.

**Step 2: Run tests to verify failure**

```bash
npm run test -- tests/unit/token-budget.test.ts tests/unit/anchor-tools.test.ts tests/integration/scoped-coverage-tools.test.ts
```

Expected: FAIL on new compact-output assertions.

**Step 3: Implement minimal change**

- Add small helper functions in `output-profile.ts` for `shapeCoveragePlan` and compact `shapeReadSpan` preview.
- Use those helpers for compact/navigation prepare; keep standard/debug more detailed.
- Change `anchorStatusData` to accept `responseProfile`; compact returns counts, budgets, anchor preview, tombstone counts, navigation card preview, omitted counts, and optional short text preview only.
- Ensure promote/demote success envelopes also default to compact anchor status.

**Step 4: Run tests to verify pass**

Run the same targeted tests. Expected: PASS.

**Step 5: Commit checkpoint if isolated**

```bash
git add packages/core/src/mcp/output-profile.ts packages/core/src/mcp/tools/nl-anchor.ts packages/core/src/mcp/tools/nl-status.ts tests/unit/token-budget.test.ts tests/unit/anchor-tools.test.ts tests/integration/scoped-coverage-tools.test.ts
git commit -m "fix: compact navigation and prepare outputs"
```

---

### Task 4: Repair public CLI contract for status/help

**Objective:** Provide a real top-level `status` command and stop unknown command help false positives.

**Files:**
- Modify: `packages/core/src/cli/main.ts`
- Modify: `packages/core/src/cli/help.ts`
- Test: `tests/unit/cli-help.test.ts`

**Design refs:** B8, D7, C3.

**Why this is not append-only:** It extends the existing CLI parser and deliberately rejects fake help for unimplemented commands instead of adding compatibility aliases.

**Step 1: Write failing tests**

Add assertions that:
- `runCli(['status', '--project', projectRoot])` returns a JSON envelope with `tool: 'nl_status'` and exit code based on `ok`.
- `runCli(['status', '--help'])` prints command-specific help and exits 0.
- `runCli(['prepare', '--help'])` exits 1 with validation JSON for an unknown command.
- Root `--help` still exits 0.

**Step 2: Run tests to verify failure**

```bash
npm run test -- tests/unit/cli-help.test.ts
```

Expected: FAIL before implementation.

**Step 3: Implement minimal change**

- Add `parseStatusArgs` and `runStatusCommand` mirroring anchor status payload handling without requiring `anchor` prefix.
- Treat help globally only when argv is empty or the first arg is `--help`/`-h`.
- Add concise command-specific status help to `help.ts`.

**Step 4: Run tests to verify pass**

Run the same test file. Expected: PASS.

**Step 5: Commit checkpoint if isolated**

```bash
git add packages/core/src/cli/main.ts packages/core/src/cli/help.ts tests/unit/cli-help.test.ts
git commit -m "fix: expose stable noemaloom status cli"
```

---

### Task 5: Run full verification and update the problem ledger

**Objective:** Prove the repairs with real tool output and update `/home/xu/project/tests/neomaloom/problems.md` truthfully.

**Files:**
- Modify: `/home/xu/project/tests/neomaloom/problems.md`

**Design refs:** D9.

**Step 1: Run quality gates**

```bash
npm run typecheck
npm run build
npm run test:all
```

Expected: all pass.

**Step 2: Run real smoke checks**

Run compact/default probes against:
- `/home/xu/project/tests/neomaloom/loop`
- `/home/xu/project/tests/neomaloom/fseg`
- parent `/home/xu/project/tests/neomaloom`

Minimum probes:

```bash
node packages/core/dist/cli/main.js status --project /home/xu/project/tests/neomaloom/loop
node packages/core/dist/cli/main.js status --project /home/xu/project/tests/neomaloom/fseg
```

Use MCP handler scripts for `nl_prepare_context` if needed to inspect token budgets and paths.

**Step 3: Update ledger**

Mark each NAVDAILY6 item as:
- fixed in this pass,
- partially fixed with remaining phase-2 work, or
- intentionally deferred.

Include exact command names and output summaries; do not claim issues fixed without tool output.

**Step 4: Final repo hygiene**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: only intended code/test/docs changes plus local ignored ledger updates.

import { classifyFileRole } from '../../packages/core/src/files/role-classifier.js';
import { classifyPathLayer, isDefaultBusinessPath } from '../../packages/core/src/files/path-layer.js';

const roleCases: Array<[string, ReturnType<typeof classifyFileRole>]> = [
  ['README.md', 'readme_doc'],
  ['CHANGELOG.md', 'changelog_doc'],
  ['CODEX_STATE.md', 'design_doc'],
  ['docs/api/client.md', 'canonical_api_doc'],
  ['docs/reference/client.md', 'canonical_api_doc'],
  ['docs/tutorial-first/intro.md', 'tutorial_doc'],
  ['examples/basic.ts', 'example_doc'],
  ['paper/notes.md', 'paper_doc'],
  ['notes/run.md', 'experiment_note_doc'],
  ['design/arch.md', 'design_doc'],
  ['docs/design/arch.md', 'design_doc'],
  ['src/app.ts', 'source_file'],
  ['lib/app.ts', 'source_file'],
  ['packages/core/src/index.ts', 'source_file'],
  ['tests/app.test.ts', 'test_file'],
  ['test/app.ts', 'test_file'],
  ['fixtures/sample.json', 'fixture_file'],
  ['config/settings.yaml', 'config_file'],
  ['schema/settings.schema.json', 'schema_file'],
  ['package.json', 'package_metadata'],
  ['pyproject.toml', 'package_metadata'],
  ['features/plan.md', 'feature_plan'],
  ['vendor/pkg/index.js', 'vendor_file'],
  ['resources/code/github/example/src/index.ts', 'vendor_file'],
  ['dist/app.js', 'generated_file'],
  ['build/app.js', 'generated_file'],
  ['coverage/summary.json', 'generated_file'],
  ['tests/__pycache__/test_client.cpython-312.pyc', 'generated_file'],
  ['DeepScientist/quests/001/experiments/stage10/run.json', 'experiment_note_doc'],
  ['DeepScientist/quests/001/experiments/stage10/scripts/stage10_loopcert_score.py', 'source_file'],
  ['DeepScientist/quests/001/experiments/stage10/tests/test_stage10_loopcert_score.py', 'test_file'],
  ['DeepScientist/quests/001/experiments/stage10/tests/__pycache__/test_stage10_loopcert_score.cpython-312.pyc', 'generated_file'],
  ['DeepScientist/quests/001/.ds/bash_exec/terminal.log', 'experiment_note_doc'],
  ['DeepScientist/quests/001/resources/code/github/huggingface__transformers/src/transformers/modeling_utils.py', 'vendor_file'],
  ['misc/file.bin', 'unknown']
];

describe('file role classifier', () => {
  it.each(roleCases)('classifies %s as %s', (repoPath, expected) => {
    expect(classifyFileRole(repoPath)).toBe(expected);
  });

  it('classifies non-business path layers separately from file roles', () => {
    expect(classifyPathLayer('.agents/skills/review/SKILL.md')).toBe('tooling_agent');
    expect(classifyPathLayer('hermes-plugin-backups/noemaloom/src/index.ts')).toBe('backup');
    expect(classifyPathLayer('artifacts/daily/run.json')).toBe('artifact');
    expect(classifyPathLayer('runs/exp-001/checkpoints/model.bin')).toBe('artifact');
    expect(classifyPathLayer('token_efficiency_benchmark/result.md')).toBe('artifact');
    expect(classifyPathLayer('archive/old-plan.md')).toBe('archive');
    expect(classifyPathLayer('planning_archive/old-plan.md')).toBe('archive');
    expect(classifyPathLayer('quest001_p0_repair_worktree/src/client.py')).toBe('repair_worktree');
    expect(classifyPathLayer('.pytest_cache/v/cache/nodeids')).toBe('artifact');
    expect(classifyPathLayer('src/client.ts')).toBe('business');
    expect(isDefaultBusinessPath('.agents/skills/review/SKILL.md')).toBe(false);
    expect(isDefaultBusinessPath('quest001_p0_repair_worktree/src/client.py')).toBe(false);
    expect(isDefaultBusinessPath('src/client.ts')).toBe(true);
  });
});

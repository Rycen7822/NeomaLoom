export const SPAN_KINDS = [
  'file',
  'code.module',
  'code.class',
  'code.interface',
  'code.struct',
  'code.enum',
  'code.function',
  'code.method',
  'code.property',
  'code.variable',
  'code.constant',
  'code.callsite',
  'code.import',
  'code.route',
  'code.component',
  'doc.file',
  'doc.frontmatter',
  'doc.heading',
  'doc.section',
  'doc.paragraph',
  'doc.list',
  'doc.table',
  'doc.code_fence',
  'doc.quote',
  'doc.link',
  'doc.anchor',
  'config.file',
  'config.object',
  'config.entry',
  'config.array_item',
  'test.file',
  'test.case',
  'test.fixture',
  'example.file',
  'example.block',
  'feature.node',
  'feature.task',
  'feature.dep_node'
] as const;

export const FILE_ROLES = [
  'source_file',
  'test_file',
  'fixture_file',
  'config_file',
  'schema_file',
  'canonical_api_doc',
  'tutorial_doc',
  'quickstart_doc',
  'example_doc',
  'paper_doc',
  'experiment_note_doc',
  'changelog_doc',
  'design_doc',
  'readme_doc',
  'feature_plan',
  'package_metadata',
  'generated_file',
  'vendor_file',
  'unknown'
] as const;

export const EDGE_RELATIONS = [
  'contains',
  'calls',
  'imports',
  'exports',
  'extends',
  'implements',
  'references',
  'instantiates',
  'overrides',
  'decorates',
  'links_to',
  'mentions',
  'documents',
  'documented_by',
  'example_of',
  'tests',
  'configured_by',
  'defines_config',
  'uses_config',
  'defines_cli_flag',
  'uses_cli_flag',
  'feature_contains',
  'feature_implemented_by',
  'feature_documented_by',
  'task_touches',
  'same_concept_as',
  'verify_after_edit'
] as const;

export type SpanKind = (typeof SPAN_KINDS)[number];
export type FileRole = (typeof FILE_ROLES)[number];
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

class SpanEnumValidationError extends Error {
  constructor(readonly code: string, readonly value: string) {
    super(`${code}: ${value}`);
    this.name = 'SpanEnumValidationError';
  }
}

function assertEnumValue<T extends string>(
  values: readonly T[],
  value: string,
  code: string
): T {
  if (values.includes(value as T)) {
    return value as T;
  }

  throw new SpanEnumValidationError(code, value);
}

export function assertSpanKind(value: string): SpanKind {
  return assertEnumValue(SPAN_KINDS, value, 'invalid_span_kind');
}

export function assertFileRole(value: string): FileRole {
  return assertEnumValue(FILE_ROLES, value, 'invalid_file_role');
}

export function assertEdgeRelation(value: string): EdgeRelation {
  return assertEnumValue(EDGE_RELATIONS, value, 'invalid_edge_relation');
}

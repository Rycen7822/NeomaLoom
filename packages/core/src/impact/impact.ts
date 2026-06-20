import { traceGraph, type TraceNode } from './trace.js';

const MAX_IMPACT_NODES_PER_GROUP = 25;
const MAX_IMPACT_PATHS = 50;

export type ImpactResult = {
  codeImpact: TraceNode[];
  docImpact: TraceNode[];
  configImpact: TraceNode[];
  testImpact: TraceNode[];
  exampleImpact: TraceNode[];
  featureImpact: TraceNode[];
  impactCoverage: 'full' | 'scoped' | 'none';
  missingUnindexedPaths: string[];
  riskLevel: 'low' | 'medium' | 'high';
  requiredVerification: string[];
  requiredActions: string[];
};

function uniquePaths(nodes: TraceNode[]): string[] {
  return [...new Set(nodes.map(node => node.path))].sort();
}

function role(node: TraceNode): string {
  return String(node.role);
}

function kind(node: TraceNode): string {
  return String(node.kind);
}

function capNodes(nodes: TraceNode[]): TraceNode[] {
  return nodes.slice(0, MAX_IMPACT_NODES_PER_GROUP);
}

export function computeImpact(input: {
  projectRoot: string;
  target: string;
  targetType?: string;
  depth?: number;
}): ImpactResult {
  const graph = traceGraph({
    projectRoot: input.projectRoot,
    target: input.target,
    targetType: input.targetType,
    direction: 'both',
    depth: input.depth ?? 2,
    relationTypes: ['all']
  });
  const codeImpact = graph.nodes.filter(node => role(node) === 'source_file' || kind(node).startsWith('code.'));
  const docImpact = graph.nodes.filter(node => role(node).endsWith('_doc') || kind(node).startsWith('doc.'));
  const configImpact = graph.nodes.filter(node => ['config_file', 'schema_file', 'package_metadata'].includes(role(node)) || kind(node).startsWith('config.'));
  const testImpact = graph.nodes.filter(node => role(node) === 'test_file' || kind(node).startsWith('test.'));
  const exampleImpact = graph.nodes.filter(node => role(node) === 'example_doc' || kind(node).startsWith('example.'));
  const featureImpact = graph.nodes.filter(node => role(node) === 'feature_plan' || kind(node).startsWith('feature.'));
  const requiredVerification = [...new Set([...uniquePaths(testImpact), ...uniquePaths(docImpact)])].sort();
  const impactCount = graph.nodes.length;

  return {
    codeImpact: capNodes(codeImpact),
    docImpact: capNodes(docImpact),
    configImpact: capNodes(configImpact),
    testImpact: capNodes(testImpact),
    exampleImpact: capNodes(exampleImpact),
    featureImpact: capNodes(featureImpact),
    impactCoverage: graph.impactCoverage,
    missingUnindexedPaths: graph.missingUnindexedPaths.slice(0, MAX_IMPACT_PATHS),
    riskLevel: graph.impactCoverage === 'scoped' && graph.missingUnindexedPaths.length > 0
      ? 'high'
      : impactCount >= 20 ? 'high' : impactCount >= 6 ? 'medium' : 'low',
    requiredVerification: requiredVerification.slice(0, MAX_IMPACT_PATHS),
    requiredActions: graph.requiredActions
  };
}

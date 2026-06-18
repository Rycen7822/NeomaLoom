import { traceGraph, type TraceNode } from './trace.js';

export type ImpactResult = {
  codeImpact: TraceNode[];
  docImpact: TraceNode[];
  configImpact: TraceNode[];
  testImpact: TraceNode[];
  exampleImpact: TraceNode[];
  featureImpact: TraceNode[];
  riskLevel: 'low' | 'medium' | 'high';
  requiredVerification: string[];
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
    codeImpact,
    docImpact,
    configImpact,
    testImpact,
    exampleImpact,
    featureImpact,
    riskLevel: impactCount >= 20 ? 'high' : impactCount >= 6 ? 'medium' : 'low',
    requiredVerification
  };
}

export type TreeSitterLoaderStatus = {
  available: boolean;
  reason: string;
};

export function getTreeSitterLoaderStatus(): TreeSitterLoaderStatus {
  return {
    available: false,
    reason: 'Phase 8 uses the NoemaLoom CodeGraph-derived extractor boundary without loading CodeGraph WASM runtimes.'
  };
}

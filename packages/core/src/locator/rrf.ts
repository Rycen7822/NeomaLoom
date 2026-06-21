export type WeightedRoute = {
  route: string;
  rank: number;
  weight: number;
};

export function weightedReciprocalRankScore(routes: WeightedRoute[], options: { k?: number; scale?: number; cap?: number } = {}): number {
  const k = options.k ?? 60;
  const scale = options.scale ?? 100;
  const cap = options.cap ?? 24;
  const score = routes.reduce((total, route) => total + (route.weight * scale) / (k + Math.max(1, route.rank)), 0);
  return Math.min(cap, Math.round(score));
}

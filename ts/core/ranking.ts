/**
 * Closed-form rank modifiers — versioned in git, no learned components.
 * Quality-tier prior times recency decay with a floor. Curated content decays
 * on a gentler half-life but DOES decay (curation-rot rule).
 */

export const TIER_PRIOR: Record<string, number> = {
  curated: 1.15,
  authored: 1.0,
  generated: 0.9,
  raw: 0.8,
};
export const RECENCY_FLOOR = 0.6;
export const HALF_LIFE_DAYS: Record<string, number> = { curated: 365.0 };
export const DEFAULT_HALF_LIFE_DAYS = 180.0;

export function modifier(tier: string, updatedAt: Date | null, now?: Date): number {
  const prior = TIER_PRIOR[tier] ?? 1.0;
  if (updatedAt === null) return prior * RECENCY_FLOOR; // unknown age is old, not fresh
  const nowMs = (now ?? new Date()).getTime();
  const ageDays = Math.max(0, (nowMs - updatedAt.getTime()) / 86_400_000);
  const halfLife = HALF_LIFE_DAYS[tier] ?? DEFAULT_HALF_LIFE_DAYS;
  const recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 2 ** (-ageDays / halfLife);
  return prior * recency;
}

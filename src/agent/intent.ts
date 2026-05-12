/**
 * Vibe Mode intent classification (spec §5.10).
 *
 * Matches the user's free-text message against three scripted scenarios.
 * Unmatched messages return `null`, which the route turns into the LLM
 * fallback per AC-40.
 */

export type ScenarioKey = 'archive' | 'multi' | 'drift' | 'promote';

export interface ClassifiedIntent {
  scenario: ScenarioKey | null;
  /** Free-form hint to surface in the console log. */
  reason: string;
}

const RULES: Array<{ pattern: RegExp; scenario: ScenarioKey; reason: string }> = [
  {
    pattern: /\b(archive|delete|deletion)\b/i,
    scenario: 'archive',
    reason: 'archive lifecycle → Class I SCR (contract change)',
  },
  {
    pattern: /\b(multi.?user|team|postgres)\b/i,
    scenario: 'multi',
    reason: 'team variant resolution',
  },
  {
    pattern: /\b(drift|hand.?edit|reconcil)/i,
    scenario: 'drift',
    reason: 'drift reconciliation',
  },
  {
    pattern: /\b(promote|library|reuse|share)\b/i,
    scenario: 'promote',
    reason: 'reuse promotion lifecycle',
  },
];

export function classifyIntent(message: string): ClassifiedIntent {
  const trimmed = message.trim();
  if (!trimmed) return { scenario: null, reason: 'empty message' };
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return { scenario: rule.scenario, reason: rule.reason };
    }
  }
  return { scenario: null, reason: 'no scripted scenario matched' };
}

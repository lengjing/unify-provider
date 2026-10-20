export interface ModelLimits {
  readonly maxOutputTokens: number;
  readonly contextWindow: number;
  readonly source: string;
  readonly verifiedAt: string;
}

function documented(slug: string, maxOutputTokens: number, contextWindow: number, verifiedAt: string): ModelLimits {
  return Object.freeze({ maxOutputTokens, contextWindow,
    source: `https://developers.openai.com/api/docs/models/${slug}`,
    verifiedAt });
}

const documentedModels = {
  'gpt-5.5': documented('gpt-5.5', 128_000, 1_050_000, '2026-10-20'),
  'gpt-5.6-luna': documented('gpt-5.6-luna', 128_000, 1_050_000, '2026-10-20'),
  'gpt-5.6-sol': documented('gpt-5.6-sol', 128_000, 1_050_000, '2026-10-20'),
  'gpt-5.6-terra': documented('gpt-5.6-terra', 128_000, 1_050_000, '2026-10-20'),
  'gpt-6-astra': documented('gpt-6-astra', 128_000, 1_050_000, '2026-10-20'),
  'gpt-6-luna': documented('gpt-6-luna', 128_000, 1_050_000, '2026-10-20'),
  'gpt-6-sol': documented('gpt-6-sol', 128_000, 1_050_000, '2026-10-20'),
  'gpt-6.1-sol': documented('gpt-6.1-sol', 128_000, 1_050_000, '2026-10-20'),
};

// The official catalog does not list SIWC's -fast slugs separately. Reuse the
// base model's published limits, not a separately verified fast-model claim.
// Fast mode: https://developers.openai.com/api/docs/guides/fast-mode
export const modelLimits: Readonly<Record<string, ModelLimits>> = Object.freeze(Object.fromEntries(
  Object.entries(documentedModels).flatMap(([slug, limits]) => [[slug, limits], [`${slug}-fast`, limits]]),
));

const slugs = Object.keys(modelLimits).sort((a, b) => b.length - a.length);

export function resolveModelLimits(slug: string): ModelLimits | undefined {
  // Longest match first; a hyphen boundary prevents gpt-6 matching gpt-6.1.
  const match = slugs.find(candidate => slug === candidate || slug.startsWith(`${candidate}-`));
  return match === undefined ? undefined : modelLimits[match];
}

export function resolveMaxOutputTokens(slug: string): number | undefined {
  return resolveModelLimits(slug)?.maxOutputTokens;
}

function conservative(limits: readonly ModelLimits[]): ModelLimits | undefined {
  return [...limits].sort((a, b) => a.maxOutputTokens - b.maxOutputTokens || a.contextWindow - b.contextWindow)[0];
}

export function resolveFamilyModelLimits(slug: string): ModelLimits | undefined {
  // Only an already documented exact generation (5.6, 6, 6.1, etc.) qualifies;
  // new generations are unknown. Unlisted tiers use the smallest verified cap
  // in their family, not an assertion that the tier itself was documented.
  const family = /^gpt-\d+(?:\.\d+)?(?=-|$)/.exec(slug)?.[0];
  if (!family) return undefined;
  return conservative(Object.entries(documentedModels)
    .filter(([candidate]) => candidate === family || candidate.startsWith(`${family}-`))
    .map(([, limits]) => limits));
}

// Nonempty, checked-in official data; never invent a limit for an unknown slug.
export const conservativeModelLimits: ModelLimits = conservative(Object.values(documentedModels))!;

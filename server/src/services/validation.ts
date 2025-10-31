import { getDefaultLlm, getDefaultSearch } from './providers.js';

type ConfidenceTier = 'low' | 'medium' | 'high';

export interface ValidationCitation {
  title?: string;
  domain: string;
  url: string;
  date?: string;
  quality: number; // 0..1
}

export interface ValidationOutput {
  confidence: number; // 0..1
  tier: ConfidenceTier;
  claim: string;
  citations: ValidationCitation[];
  rationale: string[]; // brief bullets
  next_steps?: string;
}

interface EvidenceItem {
  title?: string;
  url: string;
  snippet?: string;
  domain: string;
  date?: string;
}

interface LoopConfig {
  kInitial: number;
  kMax: number;
  maxLoops: number;
  targetConf: number;
  weights: { diversity: number; quality: number; recency: number; consistency: number };
  recencyWindows: { d30: number; d180: number; d365: number };
  selfConsistencyRuns: number;
}

type LoopConfigOverrides =
  Partial<Omit<LoopConfig, 'weights' | 'recencyWindows'>> & {
    weights?: Partial<LoopConfig['weights']>;
    recencyWindows?: Partial<LoopConfig['recencyWindows']>;
  };

const DEFAULTS: LoopConfig = {
  kInitial: Number(process.env.VALIDATE_K_INITIAL || 10),
  kMax: Number(process.env.VALIDATE_K_MAX || 20),
  maxLoops: Number(process.env.VALIDATE_MAX_LOOPS || 2),
  targetConf: Number(process.env.VALIDATE_TARGET_CONF || 0.75),
  weights: {
    diversity: Number(process.env.VALIDATE_W_DIV || 0.35),
    quality: Number(process.env.VALIDATE_W_QUAL || 0.30),
    recency: Number(process.env.VALIDATE_W_REC || 0.20),
    consistency: Number(process.env.VALIDATE_W_CONS || 0.15)
  },
  recencyWindows: { d30: 30, d180: 180, d365: 365 },
  selfConsistencyRuns: Number(process.env.VALIDATE_SELF_RUNS || 3)
};

function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function classifyDomainQuality(domain: string): number {
  const d = domain.toLowerCase();
  // Official and primary sources
  if (d.endsWith('.gov') || d.endsWith('.gov.uk') || d.endsWith('.eu')) return 1.0;
  if (d.endsWith('.edu')) return 0.95;
  // Reputable outlets (expandable)
  const topTier = ['nytimes.com', 'wsj.com', 'washingtonpost.com', 'bbc.co.uk', 'bbc.com', 'reuters.com', 'apnews.com', 'bloomberg.com'];
  if (topTier.some(t => d === t || d.endsWith('.' + t))) return 0.9;
  // Social media
  const social = ['twitter.com', 'x.com', 'facebook.com', 'tiktok.com', 'instagram.com', 'reddit.com', 'youtube.com', 'medium.com'];
  if (social.some(t => d === t || d.endsWith('.' + t))) return 0.3;
  // Blogs and misc
  return 0.6; // mid default; refined later by source type if available
}

function isLikelySyndication(url: string): boolean {
  const d = extractDomain(url);
  return /news\.yahoo\.com|msn\.com|aol\.com/.test(d);
}

function recencyScore(isoDate?: string, now: Date = new Date()): number {
  if (!isoDate) return 0.6; // unknown date: neutral-ish
  const published = new Date(isoDate);
  if (isNaN(published.getTime())) return 0.6;
  const days = Math.floor((now.getTime() - published.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 30) return 1.0;
  if (days <= 180) return 0.8;
  if (days <= 365) return 0.6;
  return 0.4;
}

function diversityScore(evidence: EvidenceItem[]): number {
  const domains = new Set<string>();
  for (const e of evidence) {
    if (isLikelySyndication(e.url)) continue;
    domains.add(e.domain);
  }
  if (evidence.length === 0) return 0;
  return Math.min(1, domains.size / Math.max(1, evidence.length));
}

function computeConsistency(claims: string[]): { score: number; disagreementRate: number } {
  if (claims.length === 0) return { score: 0.5, disagreementRate: 0.5 };
  const norm = claims.map(c => normalizeClaim(c));
  const counts = new Map<string, number>();
  for (const c of norm) counts.set(c, (counts.get(c) || 0) + 1);
  const maxCount = Math.max(...Array.from(counts.values()));
  const disagreementRate = 1 - maxCount / norm.length;
  return { score: 1 - disagreementRate, disagreementRate };
}

function normalizeClaim(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toTier(conf: number): ConfidenceTier {
  if (conf < 0.55) return 'low';
  if (conf < 0.75) return 'medium';
  return 'high';
}

function uniqueByUrl(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

function normalizeResults(results: { title?: string; url: string; snippet?: string }[]): EvidenceItem[] {
  return results.map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    domain: extractDomain(r.url)
  }));
}

async function extractClaimWithContext(question: string, evidence: EvidenceItem[], llm: ReturnType<typeof getDefaultLlm>): Promise<string> {
  const context = evidence.map((e, i) => `#${i + 1} ${e.title ?? ''}\n${e.url}\n${e.snippet ?? ''}`).join('\n\n');
  const prompt = `Given the user question, extract the single, most precise claim you intend to answer.\nExpress it in normalized present-tense, short, unambiguous form.\nReturn ONLY the claim text with no extra words.\n\nQuestion: ${question}\n\nEvidence:\n${context}`;
  const raw = await llm.complete(prompt);
  return raw.trim();
}

export async function validateSources(question: string, opts?: LoopConfigOverrides): Promise<ValidationOutput> {
  const cfg: LoopConfig = {
    ...DEFAULTS,
    ...opts,
    weights: { ...DEFAULTS.weights, ...(opts?.weights || {}) },
    recencyWindows: { ...DEFAULTS.recencyWindows, ...(opts?.recencyWindows || {}) }
  };
  const search = getDefaultSearch();
  const llm = getDefaultLlm();

  let k = cfg.kInitial;
  let loop = 0;
  let collected: EvidenceItem[] = [];
  let claimHypotheses: string[] = [];

  while (loop < cfg.maxLoops) {
    const queries: string[] = reformulateQueries(question, loop);
    const batches = await Promise.all(
      queries.map(q => search.search(q, { num: Math.min(k, cfg.kMax) }))
    );
    const merged = uniqueByUrl(normalizeResults(batches.flat()));
    collected = uniqueByUrl([...collected, ...merged]);

    // scoring
    const diversity = diversityScore(collected);
    const qualityVals = collected.map(e => classifyDomainQuality(e.domain));
    const quality = qualityVals.length ? average(qualityVals) : 0;
    const recencyVals = collected.map(e => recencyScore(e.date));
    const recency = recencyVals.length ? average(recencyVals) : 0.6;

    // self-consistency runs
    const runs = Math.max(1, cfg.selfConsistencyRuns);
    const runClaims: string[] = [];
    for (let i = 0; i < runs; i++) {
      runClaims.push(await extractClaimWithContext(question, collected.slice(0, Math.min(collected.length, 12)), llm));
    }
    claimHypotheses = runClaims;
    const { score: consistency, disagreementRate } = computeConsistency(runClaims);

    const confidence =
      cfg.weights.diversity * diversity +
      cfg.weights.quality * quality +
      cfg.weights.recency * recency +
      cfg.weights.consistency * consistency;

    const tier = toTier(confidence);

    const independenceOk = countIndependentDomains(collected) >= (tier === 'high' ? 3 : 2);
    if (confidence >= cfg.targetConf && independenceOk) {
      return composeAnswer(question, collected, confidence, tier, quality, recency, diversity, consistency, disagreementRate, runClaims);
    }

    // Otherwise, widen search
    k = Math.min(cfg.kMax, k + 5);
    loop += 1;
  }

  // Final answer after loops exhausted
  const diversity = diversityScore(collected);
  const qualityVals = collected.map(e => classifyDomainQuality(e.domain));
  const quality = qualityVals.length ? average(qualityVals) : 0;
  const recencyVals = collected.map(e => recencyScore(e.date));
  const recency = recencyVals.length ? average(recencyVals) : 0.6;
  const { score: consistency, disagreementRate } = computeConsistency(claimHypotheses);
  const confidence = cfg.weights.diversity * diversity + cfg.weights.quality * quality + cfg.weights.recency * recency + cfg.weights.consistency * consistency;
  const tier = toTier(confidence);
  return composeAnswer(question, collected, confidence, tier, quality, recency, diversity, consistency, disagreementRate, claimHypotheses);
}

function composeAnswer(
  question: string,
  evidence: EvidenceItem[],
  confidence: number,
  tier: ConfidenceTier,
  quality: number,
  recency: number,
  diversity: number,
  consistency: number,
  disagreementRate: number,
  claims: string[]
): ValidationOutput {
  const topCitations = selectCitations(evidence).slice(0, 3);
  const claim = claims.length ? mostCommon(claims) : normalizeClaim(question);
  const rationale: string[] = [
    `Diversity score=${diversity.toFixed(2)} (${countIndependentDomains(evidence)} independent domains)`,
    `Quality score=${quality.toFixed(2)}`,
    `Recency score=${recency.toFixed(2)}`,
    `Self-consistency=${consistency.toFixed(2)} (disagreement ${disagreementRate.toFixed(2)})`
  ];
  const next = tier === 'high' ? undefined : nextStepSuggestion(question, evidence);
  return {
    confidence: clamp01(confidence),
    tier,
    claim,
    citations: topCitations,
    rationale,
    next_steps: next
  };
}

function selectCitations(evidence: EvidenceItem[]): ValidationCitation[] {
  // Prefer official/high quality and non-syndicated
  const scored = evidence.map(e => ({ e, qual: classifyDomainQuality(e.domain), synd: isLikelySyndication(e.url) }));
  scored.sort((a, b) => (b.qual - a.qual) || Number(a.synd) - Number(b.synd));
  return scored.map(s => ({ title: s.e.title, domain: s.e.domain, url: s.e.url, date: s.e.date, quality: s.qual }));
}

function nextStepSuggestion(question: string, evidence: EvidenceItem[]): string {
  const entityHint = extractEntityHint(question);
  const base = entityHint ? `${entityHint} official site or press release` : 'official site or press release';
  return `Seek corroboration from ${base}; add a year range like 2024..2025 and include keywords like "press release" or "newsroom".`;
}

function extractEntityHint(q: string): string | undefined {
  const m = q.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/);
  return m ? m[1] : undefined;
}

function reformulateQueries(q: string, loop: number): string[] {
  const base = q;
  const entity = extractEntityHint(q);
  const yearRange = new Date().getFullYear();
  const range = `${yearRange - 1}..${yearRange}`;
  if (loop === 0) return [base];
  if (loop === 1) {
    return [
      `${base} official site`,
      `${base} press release ${range}`,
      entity ? `${entity} site:linkedin.com/company` : `${base} site:linkedin.com/company`,
      `${base} site:wikipedia.org ${range}`
    ];
  }
  return [
    `${base} newsroom ${range}`,
    `${base} SEC filing ${range}`,
    `${base} update ${range}`,
    `${base} clarification ${range}`
  ];
}

function countIndependentDomains(evidence: EvidenceItem[]): number {
  const domains = new Set<string>();
  for (const e of evidence) {
    if (isLikelySyndication(e.url)) continue;
    domains.add(e.domain);
  }
  return domains.size;
}

function average(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0];
  let bestC = 0;
  for (const [k, v] of counts) {
    if (v > bestC) { best = k; bestC = v; }
  }
  return best;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}



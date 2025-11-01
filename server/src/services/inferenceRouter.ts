import { LlmProvider } from "./providers.js";
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { MagicVariableDefinition } from '../types.js';
import { ChatOpenAI } from '@langchain/openai';

export type RouterOut = {
  entityTypePrior: Record<string, number>; // e.g., {"organization":0.5,"person":0.2,"concept":0.1,...}
  attrConstraints: Record<string, "required" | "allowed" | "forbidden">; // from expectedVars + commonsense
  vocabHints: { boost: string[]; penalize: string[] };
  evidencePolicy: { minCorroboration: number; requireAuthority: boolean; freshnessDays?: number };
};

export interface InferenceRouterInput {
  query: string;
  expectedVars: MagicVariableDefinition[];
  entity?: string;
}

const ENTITY_TYPES = [
  'person', 'organization', 'product', 'place', 'event', 'concept', 'artifact', 'other'
];

function normalizeEntityTypePrior(prior: Record<string, number>): Record<string, number> {
  // Ensure all values are between 0 and 1, and normalize to sum to ~1
  const normalized: Record<string, number> = {};
  let sum = 0;
  for (const [key, value] of Object.entries(prior)) {
    const clamped = Math.max(0, Math.min(1, typeof value === 'number' ? value : 0));
    normalized[key] = clamped;
    sum += clamped;
  }
  // If sum is 0 or very small, distribute evenly among top 3 candidates
  if (sum < 0.1) {
    const sorted = Object.entries(normalized).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const defaultProb = 1 / Math.max(sorted.length, 1);
    for (const [key] of sorted) {
      normalized[key] = defaultProb;
    }
  } else {
    // Normalize to sum to 1
    for (const key of Object.keys(normalized)) {
      normalized[key] /= sum;
    }
  }
  return normalized;
}

function createCheapLlm(): LlmProvider {
  // Use a cheaper/faster model for inference routing
  const apiKey = process.env.OPENAI_API_KEY;
  const modelName = process.env.OPENAI_INFERENCE_MODEL || 'gpt-4o-mini'; // cheap model for routing
  const model = new ChatOpenAI({
    model: modelName,
    temperature: 0.1, // Low temperature for more deterministic routing
    apiKey,
    maxRetries: 2,
    timeout: 30_000 // Shorter timeout for routing
  });
  return model;
}

export async function inferContext(input: InferenceRouterInput): Promise<RouterOut> {
  const { query, expectedVars, entity } = input;
  
  const expectedVarNames = expectedVars.map(v => v.name).join(', ');
  const entityContext = entity ? `Entity context: "${entity}"` : 'No specific entity mentioned.';

  const systemPrompt = `You are an inference router that analyzes queries to determine:
1. Entity type priors (probability distribution over entity types)
2. Attribute constraints (which attributes are required/allowed/forbidden)
3. Vocabulary hints (terms that boost/penalize certain entity types)
4. Evidence policy (corroboration requirements, authority needs, freshness)

Entity types to consider: ${ENTITY_TYPES.join(', ')}

Return ONLY valid JSON matching this schema:
{
  "entityTypePrior": { "organization": 0.5, "person": 0.2, ... },
  "attrConstraints": { "name": "required", "date": "allowed", "coordinates": "forbidden" },
  "vocabHints": { "boost": ["definition", "biography", "location"], "penalize": ["unrelated", "ambiguous"] },
  "evidencePolicy": { "minCorroboration": 2, "requireAuthority": true, "freshnessDays": 365 }
}

Rules:
- entityTypePrior: probabilities should sum to ~1.0
- attrConstraints: Use "required" for critical attributes, "allowed" for plausible ones, "forbidden" for impossible ones
- vocabHints: Include 3-8 terms that semantically indicate entity type or query intent
- evidencePolicy: Higher minCorroboration for factual claims, requireAuthority for sensitive data, freshnessDays for time-sensitive queries`;

  const userPrompt = `Query: "${query}"
Expected variables: ${expectedVarNames || 'none specified'}
${entityContext}

Analyze the query semantics and expected variables to infer:
- Which entity types are most likely (consider vocabulary, variable names, and query structure)
- Which attributes make sense for this query
- Vocabulary terms that indicate entity type
- Evidence requirements (corroboration, authority, freshness)

Return JSON only.`;

  const router = createCheapLlm();
  
  try {
    const response = await router.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt)
    ]);
    
    const raw = typeof response.content === 'string' 
      ? response.content 
      : Array.isArray(response.content)
        ? response.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
        : String(response.content);
    
    // Extract JSON from markdown code blocks if present
    let jsonStr = raw.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }
    
    const parsed = JSON.parse(jsonStr);
    
    // Validate and normalize
    const entityTypePrior = parsed.entityTypePrior || {};
    const normalizedPrior = normalizeEntityTypePrior(entityTypePrior);
    
    const attrConstraints: Record<string, "required" | "allowed" | "forbidden"> = {};
    if (parsed.attrConstraints && typeof parsed.attrConstraints === 'object') {
      for (const [key, value] of Object.entries(parsed.attrConstraints)) {
        if (value === 'required' || value === 'allowed' || value === 'forbidden') {
          attrConstraints[key] = value;
        }
      }
    }
    
    // Infer constraints from expectedVars (generic, domain-agnostic)
    for (const varDef of expectedVars) {
      // If not already set, infer generic constraint
      if (!attrConstraints[varDef.name]) {
        attrConstraints[varDef.name] = 'allowed';
      }
    }
    
    const vocabHints = {
      boost: Array.isArray(parsed.vocabHints?.boost) ? parsed.vocabHints.boost : [],
      penalize: Array.isArray(parsed.vocabHints?.penalize) ? parsed.vocabHints.penalize : []
    };
    
    const evidencePolicy = {
      minCorroboration: typeof parsed.evidencePolicy?.minCorroboration === 'number' 
        ? Math.max(1, Math.min(5, parsed.evidencePolicy.minCorroboration))
        : 1,
      requireAuthority: typeof parsed.evidencePolicy?.requireAuthority === 'boolean'
        ? parsed.evidencePolicy.requireAuthority
        : false,
      freshnessDays: typeof parsed.evidencePolicy?.freshnessDays === 'number'
        ? parsed.evidencePolicy.freshnessDays
        : undefined
    };
    
    return {
      entityTypePrior: normalizedPrior,
      attrConstraints,
      vocabHints,
      evidencePolicy
    };
    
  } catch (error) {
    // Fallback to heuristics if LLM parsing fails
    console.warn('Inference router LLM parsing failed, using heuristics:', error);
    return inferContextHeuristic(input);
  }
}

function inferContextHeuristic(input: InferenceRouterInput): RouterOut {
  const { expectedVars } = input;

  // Neutral fallback: uniform prior across entity types
  const entityTypePrior: Record<string, number> = {};
  const uniformProb = 1 / ENTITY_TYPES.length;
  for (const t of ENTITY_TYPES) {
    entityTypePrior[t] = uniformProb;
  }

  // Attribute constraints from expected vars (generic)
  const attrConstraints: Record<string, "required" | "allowed" | "forbidden"> = {};
  for (const varDef of expectedVars) {
    attrConstraints[varDef.name] = 'allowed';
  }

  // Vocabulary hints (left empty in heuristic; LLM provides when available)
  const vocabHints = { boost: [] as string[], penalize: [] as string[] };

  // Evidence policy (neutral defaults)
  const evidencePolicy = {
    minCorroboration: 1,
    requireAuthority: false,
    freshnessDays: undefined as number | undefined
  };

  return {
    entityTypePrior,
    attrConstraints,
    vocabHints,
    evidencePolicy
  };
}

import { LlmProvider } from "./providers.js";
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { MagicVariableDefinition } from '../types.js';
import { ChatOpenAI } from '@langchain/openai';

export type RouterOut = {
  entityType: string | undefined;
  attrConstraints: Record<string, "required" | "allowed" | "forbidden">; 
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

function createCheapLlm(): LlmProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  const modelName = process.env.OPENAI_INFERENCE_MODEL || 'gpt-4o-mini'; 
  const model = new ChatOpenAI({
    model: modelName,
    temperature: 0.1, 
    apiKey,
    maxRetries: 2,
    timeout: 30_000 
  });
  return model;
}

export async function inferContext(input: InferenceRouterInput): Promise<RouterOut> {
  const { query, expectedVars, entity } = input;
  
  const expectedVarNames = expectedVars.map(v => v.name).join(', ');
  const entityContext = entity ? `Entity context: "${entity}"` : 'No specific entity mentioned.';

  const systemPrompt = `You are an inference router that analyzes queries to determine:
1. Most likely entity type (single type from: ${ENTITY_TYPES.join(', ')})
2. Attribute constraints (which attributes are required/allowed/forbidden)
3. Vocabulary hints (terms that boost/penalize certain entity types)
4. Evidence policy (corroboration requirements, authority needs, freshness)

Return ONLY valid JSON matching this schema:
{
  "entityType": "organization",
  "attrConstraints": { "name": "required", "date": "allowed", "coordinates": "forbidden" },
  "vocabHints": { "boost": ["definition", "biography", "location"], "penalize": ["unrelated", "ambiguous"] },
  "evidencePolicy": { "minCorroboration": 2, "requireAuthority": true, "freshnessDays": 365 }
}

Rules:
- entityType: Choose the single most likely entity type from: ${ENTITY_TYPES.join(', ')}
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
    
    let jsonStr = raw.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }
    
    const parsed = JSON.parse(jsonStr);
    
    let entityType: string | undefined;
    if (typeof parsed.entityType === 'string' && parsed.entityType) {
      entityType = parsed.entityType;
    }
    
    if (entityType && !ENTITY_TYPES.includes(entityType)) {
      entityType = undefined;
    }
    
    const attrConstraints: Record<string, "required" | "allowed" | "forbidden"> = {};
    if (parsed.attrConstraints && typeof parsed.attrConstraints === 'object') {
      for (const [key, value] of Object.entries(parsed.attrConstraints)) {
        if (value === 'required' || value === 'allowed' || value === 'forbidden') {
          attrConstraints[key] = value;
        }
      }
    }
    
    for (const varDef of expectedVars) {
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
      entityType,
      attrConstraints,
      vocabHints,
      evidencePolicy
    };
    
  } catch (error) {
    console.warn('Inference router LLM parsing failed, using heuristics:', error);
    return inferContextHeuristic(input);
  }
}

function inferContextHeuristic(input: InferenceRouterInput): RouterOut {
  const { expectedVars } = input;

  const entityType: string | undefined = 'organization';

  const attrConstraints: Record<string, "required" | "allowed" | "forbidden"> = {};
  for (const varDef of expectedVars) {
    attrConstraints[varDef.name] = 'allowed';
  }

  const vocabHints = { boost: [] as string[], penalize: [] as string[] };

  const evidencePolicy = {
    minCorroboration: 1,
    requireAuthority: false,
    freshnessDays: undefined as number | undefined
  };

  return {
    entityType,
    attrConstraints,
    vocabHints,
    evidencePolicy
  };
}

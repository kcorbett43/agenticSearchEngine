import { LlmProvider } from './providers.js';

export type Intent = 'boolean' | 'specific' | 'contextual';

export interface ClassifiedIntent {
  intent: Intent;
  target?: string; // for specific intent, e.g., "founder", "valuation" etc.
}

export async function classifyIntent(llm: LlmProvider, query: string): Promise<ClassifiedIntent> {
  const prompt = `Classify the user's research query into one of: boolean, specific, contextual.
Return JSON with keys: intent (boolean|specific|contextual) and target (string|optional).
Examples:
- "Is Acme profitable?" -> {"intent":"boolean","target":"profitability"}
- "Who founded OpenAI?" -> {"intent":"specific","target":"founder"}
- "Tell me about Stripe's business model" -> {"intent":"contextual","target":"business model"}

Query: ${query}`;
  const raw = await llm.complete(prompt, { json: true });
  try {
    const parsed = JSON.parse(raw);
    const intent = parsed.intent as Intent;
    if (intent === 'boolean' || intent === 'specific' || intent === 'contextual') {
      return { intent, target: typeof parsed.target === 'string' ? parsed.target : undefined };
    }
  } catch {
    // fallthrough
  }
  // heuristic fallback
  const q = query.toLowerCase();
  if (q.startsWith('is ') || q.startsWith('are ') || q.endsWith('?')) return { intent: 'boolean' };
  if (q.startsWith('who ') || q.startsWith('what ') || q.startsWith('when ') || q.startsWith('where ')) return { intent: 'specific' };
  return { intent: 'contextual' };
}



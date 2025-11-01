import { LlmProvider } from "./providers";
import { HumanMessage } from '@langchain/core/messages';

export type Intent = 'boolean' | 'specific' | 'contextual';

export interface ClassifiedIntent {
  intent: Intent;
  target?: string;
}

export async function classifyIntent(llm: LlmProvider, query: string): Promise<ClassifiedIntent> {
  const prompt = `Classify the user's research query into one of: boolean, specific, contextual.
Return JSON with keys: intent (boolean|specific|contextual) and target (string|optional).
Examples:
- "Is Acme profitable?" -> {"intent":"boolean","target":"profitability"}
- "Who founded OpenAI?" -> {"intent":"specific","target":"founder"}
- "Tell me about Stripe's business model" -> {"intent":"contextual","target":"business model"}

Query: ${query}`;
  const response = await llm.invoke([new HumanMessage(prompt)]);
  const raw = typeof response.content === 'string' 
    ? response.content 
    : Array.isArray(response.content)
      ? response.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
      : String(response.content);
  try {
    const parsed = JSON.parse(raw);
    const intent = parsed.intent as Intent;
    if (intent === 'boolean' || intent === 'specific' || intent === 'contextual') {
      return { intent, target: typeof parsed.target === 'string' ? parsed.target : undefined };
    }
  } catch {}
  const q = query.toLowerCase();
  if (q.startsWith('is ') || q.startsWith('are ') || q.endsWith('?')) return { intent: 'boolean' };
  if (q.startsWith('who ') || q.startsWith('what ') || q.startsWith('when ') || q.startsWith('where ')) return { intent: 'specific' };
  return { intent: 'contextual' };
}



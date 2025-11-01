import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

type SummaryResult = {
  summary: string;
  key_facts: string[];
  quotes: string[];
  published_at: string | null;
};

export async function summarizeForQuery(text: string, query: string): Promise<SummaryResult> {
  if (!text || !query) {
    return { summary: '', key_facts: [], quotes: [], published_at: null };
  }

  if (!process.env.OPENAI_API_KEY) {
    const excerpt = text.slice(0, 800);
    return {
      summary: excerpt,
      key_facts: [],
      quotes: [],
      published_at: null
    };
  }

  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    maxRetries: 2,
    timeout: 30_000,
    apiKey: process.env.OPENAI_API_KEY
  });

  const sys = new SystemMessage(
    'Summarize evidence relevant to a user query for a research agent. Return STRICT JSON with keys: ' +
    'summary (<=220 tokens, objective, query-focused), key_facts (array of atomic short facts), ' +
    'quotes (array of short verbatim spans <=240 chars), published_at (ISO string or null). No commentary.'
  );
  const human = new HumanMessage(
    `Query: ${query}\n\nContent (truncated):\n${text.slice(0, 12000)}`
  );

  try {
    const resp = await model.invoke([sys, human]);
    const content = typeof resp.content === 'string' ? resp.content : String(resp.content);
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      
      return {
        summary: String(parsed.summary || ''),
        key_facts: Array.isArray(parsed.key_facts) ? parsed.key_facts.map((s: any) => String(s || '')).filter(Boolean) : [],
        quotes: Array.isArray(parsed.quotes) ? parsed.quotes.map((s: any) => String(s || '')).filter(Boolean) : [],
        published_at: parsed.published_at ? String(parsed.published_at) : null
      };
    }
  } catch {}

  const excerpt = text.slice(0, 800);
  return { summary: excerpt, key_facts: [], quotes: [], published_at: null };
}



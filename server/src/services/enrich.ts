import { EnrichmentResult, MagicVariableDefinition, MagicVariableValue, SourceAttribution } from '../types.js';
import { classifyIntent } from './intent.js';
import { getDefaultLlm, getDefaultSearch } from './providers.js';

function dedupeByUrl(sources: SourceAttribution[]): SourceAttribution[] {
  const seen = new Set<string>();
  const out: SourceAttribution[] = [];
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

export async function runEnrichment(query: string, expectedVars: MagicVariableDefinition[]): Promise<EnrichmentResult> {
  const llm = getDefaultLlm();
  const search = getDefaultSearch();

  const { intent, target } = await classifyIntent(llm, query);
  const web = await search.search(query, { num: 6 });

  const context = web.map((r, i) => `#${i + 1} ${r.title ?? ''}\n${r.url}\n${r.snippet ?? ''}`).join('\n\n');

  const system = `You are a careful research assistant. Use the provided web context as evidence.
Return strictly the requested JSON schema. Include sources used.`;

  const schema = `
{
  "intent": "${intent}",
  "variables": [
    {
      "name": string,
      "type": "boolean"|"string"|"number"|"date"|"url"|"text",
      "value": any,
      "confidence": number, // 0..1
      "sources": [{"title": string|optional, "url": string, "snippet": string|optional}]
    }
  ],
  "notes": string|optional
}`;

  const expectedNames = expectedVars.map(v => v.name).join(', ');
  const expectedHint = expectedNames ? `Aim to fill these variables if possible: ${expectedNames}.` : '';

  const prompt = `${system}

User query: ${query}
User intent target (may be empty): ${target ?? ''}

${expectedHint}

Web context (top results):\n${context}

Produce the JSON exactly matching this schema (no markdown):
${schema}`;

  const raw = await llm.complete(prompt, { json: true });

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { intent, variables: [], notes: 'LLM returned non-JSON; using fallback.' } as EnrichmentResult;
  }

  const variables: MagicVariableValue[] = Array.isArray(parsed?.variables) ? parsed.variables : [];

  // Post-process: ensure types, bounds, and add missing sources if we have matching URLs from search
  for (const v of variables) {
    if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1) v.confidence = 0.5;
    if (!Array.isArray(v.sources)) v.sources = [];
    v.sources = dedupeByUrl(v.sources);
  }

  // If nothing was extracted, provide a contextual summary variable as a fallback
  if (variables.length === 0) {
    variables.push({
      name: 'context',
      type: 'text',
      value: web.map(r => `${r.title ?? r.url}: ${r.snippet ?? ''}`).join('\n'),
      confidence: 0.4,
      sources: web.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }))
    });
  }

  const result: EnrichmentResult = {
    intent,
    variables,
    notes: typeof parsed?.notes === 'string' ? parsed.notes : undefined
  };

  return result;
}



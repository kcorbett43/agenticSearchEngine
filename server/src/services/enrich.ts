import { EnrichmentResult, MagicVariableDefinition, MagicVariableValue, SourceAttribution } from '../types.js';
import { classifyIntent } from './intent.js';
import { getDefaultLlm, getDefaultSearch } from './providers.js';
import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';
import { getHistory, trimHistory } from './memory.js';
import { addMemory } from './longTermMemory.js';
import { z } from 'zod';

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

export async function runEnrichment(query: string, expectedVars: MagicVariableDefinition[], sessionId?: string, username?: string): Promise<EnrichmentResult> {
  const llm = getDefaultLlm();
  const search = getDefaultSearch();

  const { intent, target } = await classifyIntent(llm, query);
  const web = await search.search(query, { num: 6 });

  const context = web.map((r, i) => `#${i + 1} ${r.title ?? ''}\n${r.url}\n${r.snippet ?? ''}`).join('\n\n');

  const system = `You are a careful research assistant. Use the provided web context as evidence.
Return strictly the requested JSON schema. Include sources used.`;

  const schemaText = `
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

  const EnrichmentSchema = z.object({
    intent: z.enum(['boolean', 'specific', 'contextual']),
    variables: z.array(z.object({
      name: z.string(),
      type: z.enum(['boolean', 'string', 'number', 'date', 'url', 'text']),
      value: z.union([z.boolean(), z.number(), z.string()]).nullable(),
      confidence: z.number().min(0).max(1).default(0.5),
      sources: z.array(z.object({
        title: z.string().nullable(),
        url: z.string(),
        snippet: z.string().nullable()
      })).default([])
    })).default([]),
    notes: z.string().nullable()
  });

  // If no API key, keep stateless behavior
  if (!process.env.OPENAI_API_KEY) {
    const prompt = `${system}

User query: ${query}
User intent target (may be empty): ${target ?? ''}

${expectedHint}

Web context (top results):\n${context}

Produce the JSON exactly matching this schema (no markdown):
${schemaText}`;
    const raw = await llm.complete(prompt, { json: true });
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
      const safe = EnrichmentSchema.safeParse(parsed);
      if (safe.success) parsed = safe.data; // normalized by zod defaults
    } catch {
      // fall through to existing finalize handling
    }
    return finalizeResult(parsed ? JSON.stringify(parsed) : raw, intent, web);
  }

  // With API key: use short-term memory via RunnableWithMessageHistory
  const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const model = new ChatOpenAI({
    model: modelName,
    temperature: 0.2,
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 2,
    timeout: 60_000
  });

  const promptTmpl = ChatPromptTemplate.fromMessages([
    ['system', system],
    new MessagesPlaceholder('history'),
    ['human', `User query: {query}\nUser intent target (may be empty): {target}\n\n{expectedHint}\n\nWeb context (top results):\n{context}\n\nProduce the JSON exactly matching this schema (no markdown):\n{schema}`]
  ]);

  const parsedModel = model.withStructuredOutput(EnrichmentSchema);
  const chain = promptTmpl.pipe(parsedModel).withConfig({ runName: 'runEnrichment' });
  const withHistory = new RunnableWithMessageHistory({
    runnable: chain,
    getMessageHistory: (sid: string) => getHistory(sid),
    inputMessagesKey: 'query',
    historyMessagesKey: 'history'
  });

  const sid = sessionId || 'default';
  const aiMessage: any = await withHistory.invoke(
    { query, target: target ?? '', expectedHint, context, schema: schemaText },
    { configurable: { sessionId: sid } }
  );
  await maybeSummarizeAndPersist(sid, username);
  await trimHistory(sid);

  const raw = JSON.stringify(aiMessage ?? {});
  return finalizeResult(raw, intent, web);
}

function finalizeResult(raw: string, intent: EnrichmentResult['intent'], web: { title?: string; url: string; snippet?: string }[]): EnrichmentResult {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { intent, variables: [], notes: 'LLM returned non-JSON; using fallback.' } as EnrichmentResult;
  }

  const variables: MagicVariableValue[] = Array.isArray(parsed?.variables) ? parsed.variables : [];

  for (const v of variables) {
    if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1) v.confidence = 0.5;
    if (!Array.isArray(v.sources)) v.sources = [];
    v.sources = dedupeByUrl(v.sources);
  }

  if (variables.length === 0) {
    variables.push({
      name: 'context',
      type: 'text',
      value: web.map(r => `${r.title ?? r.url}: ${r.snippet ?? ''}`).join('\n'),
      confidence: 0.4,
      sources: web.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }))
    });
  }

  return {
    intent,
    variables,
    notes: typeof parsed?.notes === 'string' ? parsed.notes : undefined
  };
}

async function maybeSummarizeAndPersist(sessionId: string, username?: string): Promise<void> {
  try {
    if (!username) return;
    const history = getHistory(sessionId);
    const messages = await history.getMessages();
    const MAX_MESSAGES = Number(process.env.CHAT_MEMORY_WINDOW || 8);
    if (messages.length <= MAX_MESSAGES) return;

    const transcript = messages
      .map((m: any) => `${m._getType && m._getType() === 'ai' ? 'Assistant' : 'User'}: ${typeof m.content === 'string' ? m.content : ''}`)
      .join('\n');

    const llm = getDefaultLlm();
    const prompt = `From the following chat transcript, extract only durable user facts or preferences that will help future conversations.\nReturn 3-8 concise bullet points. Each bullet MUST be a single sentence, objective, and attributable to the user when applicable.\nIf nothing durable, return an empty list.\n\nTranscript:\n${transcript}\n\nOutput format (no markdown, newline-separated bullets):`;

    const raw = await llm.complete(prompt);
    const extracted = raw
      .split('\n')
      .map(s => s.trim())
      .filter(s => s)
      .map(s => s.replace(/^[-*]\s*/, ''))
      .slice(0, 8);

    for (const fact of extracted) {
      if (fact.length >= 5 && fact.length <= 300) {
        await addMemory(username, fact, ['summary']);
      }
    }
  } catch (e) {
    // swallow summarization errors to avoid breaking main flow
  }
}


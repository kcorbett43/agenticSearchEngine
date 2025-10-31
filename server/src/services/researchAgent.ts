// server/src/services/researchAgent.ts
import { EnrichmentResult, MagicVariableDefinition, MagicVariableValue, SourceAttribution } from '../types.js';
import { classifyIntent } from './intent.js';
import { getDefaultLlm } from './providers.js';
import { webSearchTool } from '../tools/webSearch.js';
import { ChatOpenAI } from '@langchain/openai';
import { getHistory, trimHistory } from './memory.js';
import { addMemory } from './longTermMemory.js';
import { z } from 'zod';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

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

    if (!process.env.OPENAI_API_KEY) return;

    const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const model = new ChatOpenAI({
      model: modelName,
      temperature: 0.2,
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 2,
      timeout: 60_000
    });

    const sys = new SystemMessage('From the following chat transcript, extract only durable user facts or preferences that will help future conversations. Return 3-8 concise bullet points. Each bullet MUST be a single sentence, objective, and attributable to the user when applicable. If nothing durable, return an empty list.');
    const human = new HumanMessage(`Transcript:
${transcript}

Output format (no markdown, newline-separated bullets):`);

    const ai = await model.invoke([sys, human]);
    const raw = typeof ai.content === 'string'
      ? ai.content
      : Array.isArray((ai as any).content)
        ? (ai as any).content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
        : String((ai as any).content);
    const extracted = raw
      .split('\n')
      .map((s: string) => s.trim())
      .filter((s: string) => s)
      .map((s: string) => s.replace(/^[-*]\s*/, ''))
      .slice(0, 8);

    for (const fact of extracted) {
      if (fact.length >= 5 && fact.length <= 300) {
        await addMemory(username, fact, ['summary']);
      }
    }
  } catch {
    // swallow summarization errors
  }
}

export async function runAgent(query: string, expectedVars: MagicVariableDefinition[], sessionId?: string, username?: string): Promise<EnrichmentResult> {
  const baseModel = getDefaultLlm()
  const { intent, target } = await classifyIntent(baseModel, query);

  const schemaText = `
{
  "intent": "${intent}",
  "variables": [
    {
      "name": string,
      "type": "boolean"|"string"|"number"|"date"|"url"|"text",
      "value": any,
      "confidence": number,
      "sources": [{"title": string|optional, "url": string, "snippet": string|optional}]
    }
  ],
  "notes": string|optional
}`;
  const expectedNames = expectedVars.map(v => v.name).join(', ');
  const expectedHint = expectedNames ? `Aim to fill these variables if possible: ${expectedNames}.` : '';

  const sid = sessionId || 'default_research';
  const history = getHistory(sid);

  const system = `You are a careful research agent.
- Search the web only when needed.
- Reconcile conflicting sources. Prefer (recent + authoritative) over isolated social posts.
- Detect satire/April Fools/jokes and downweight them.
- If evidence conflicts, lower confidence and summarize the disagreement.
- Output ONLY final JSON strictly matching the provided schema. No markdown, no prose.
`;

  const intro = new HumanMessage(
    `User query: ${query}
User intent target (may be empty): ${target ?? ''}

${expectedHint}

Schema to follow for FINAL answer (no markdown, JSON only):
${schemaText}`
  );

  const messages: any[] = [new SystemMessage(system), ...(await history.getMessages()), intro];

  let webResults: { title?: string; url: string; snippet?: string }[] = [];
  const MAX_STEPS = Number(process.env.RESEARCH_MAX_STEPS || 6);
  let steps = 0;
  let finalRaw = '';

  while (steps < MAX_STEPS) {
    steps += 1;
    const ai = await baseModel.invoke(messages);
    messages.push(ai);
    await history.addMessage(ai);
    console.log(`history: ${history}`);
    console.log(`messages: ${messages}`);


    const toolCalls = (ai as AIMessage).tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Model decided to produce a final answer
      finalRaw = typeof ai.content === 'string' ? ai.content : '';
      break;
    }

    for (const tc of toolCalls) {
      let result: string = '';
      try {
        const argsStr = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? '');
        if (tc.name === 'web_search') {
          result = String(await webSearchTool.invoke(argsStr));
          try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed)){
                webResults = [...webResults, ...parsed];
            }
          } catch {
            // ignore parse issues
          }
        } else {
          result = JSON.stringify({ error: `Unknown tool: ${tc.name}` });
        }
      } catch (e: any) {
        result = JSON.stringify({ error: e?.message ?? 'Tool execution failed' });
      }
      console.log(`tool call result: ${webResults}`);


      const toolMsg = new ToolMessage({
        tool_call_id: String(tc.id ?? ''),
        content: result
      });
      messages.push(toolMsg);
      await history.addMessage(toolMsg);
    }

    // Nudge to produce final JSON if we're at the last step
    if (steps === MAX_STEPS) {
      const nudge = new HumanMessage(
        'Now stop using tools and produce ONLY the final JSON strictly matching the schema.'
      );
      messages.push(nudge);
      await history.addUserMessage(nudge.content as string);

      const aiFinal = await baseModel.invoke(messages);
      messages.push(aiFinal);
      await history.addMessage(aiFinal);
      finalRaw = typeof aiFinal.content === 'string' ? aiFinal.content : '';
      break;
    }
  }

  await maybeSummarizeAndPersist(sid, username);
  await trimHistory(sid);

  // Try to validate/normalize through zod; if not valid JSON, finalizeResult handles fallback
  let normalized: string = finalRaw;
  try {
    const parsed = JSON.parse(finalRaw);
    const safe = EnrichmentSchema.safeParse(parsed);
    normalized = JSON.stringify(safe.success ? safe.data : parsed);
  } catch {
    // not JSON, will be handled by finalize
  }

  return finalizeResult(normalized, intent, webResults);
}
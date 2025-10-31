// server/src/services/researchAgent.ts
import { EnrichmentResult, MagicVariableDefinition, MagicVariableValue, SourceAttribution } from '../types.js';
import { classifyIntent } from './intent.js';
import { getDefaultLlm } from './providers.js';
import { webSearchTool } from '../tools/webSearch.js';
import { ChatOpenAI } from '@langchain/openai';
import { getHistory, trimHistory } from './memory.js';
import { addMemory } from './longTermMemory.js';
import { getTrustedFactsForEntity, storeFact } from './factsStore.js';
import { resolveEntity } from './entityResolver.js';
import { z } from 'zod';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { plausibilityCheckTool } from '../tools/plausibilityCheck.js';
import { knowledgeQueryTool } from '../tools/knowledgeQuery.js';
import { latestFinderTool } from '../tools/latestFinder.js';
import { inferContext } from './inferenceRouter.js';

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function buildRelevantTokens(userQuery: string, expectedVars: MagicVariableDefinition[], routerOut: any, entity?: string, target?: string): Set<string> {
  const tokens = new Set<string>();
  for (const t of tokenize(userQuery)) tokens.add(t);
  if (entity) for (const t of tokenize(entity)) tokens.add(t);
  if (target) for (const t of tokenize(target)) tokens.add(t);
  for (const v of expectedVars) for (const t of tokenize(v.name)) tokens.add(t);
  if (routerOut?.vocabHints?.boost) {
    for (const term of routerOut.vocabHints.boost) {
      for (const t of tokenize(term)) tokens.add(t);
    }
  }
  return tokens;
}

function isIrrelevantWebQuery(proposedQuery: string, relevant: Set<string>): { irrelevant: boolean; reason?: string } {
  const q = (proposedQuery || '').trim();
  if (!q) return { irrelevant: true, reason: 'empty query' };
  const stop = new Set(['input','query','search','pipeline','title','url','link']);
  if (stop.has(q.toLowerCase())) return { irrelevant: true, reason: `placeholder term: ${q}` };
  const qTokens = tokenize(q);
  if (qTokens.length < 2) return { irrelevant: true, reason: 'too few informative tokens' };
  const overlap = qTokens.some(t => relevant.has(t));
  if (!overlap) return { irrelevant: true, reason: 'no overlap with user/task vocabulary' };
  return { irrelevant: false };
}

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

function getAuthorityScore(url: string): number {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('sec.gov')) return 100;
    if (host.endsWith('wikidata.org')) return 90;
    if (host.endsWith('wikipedia.org')) return 85;
    if (host.endsWith('.gov')) return 80;
    if (host.endsWith('.edu')) return 75;
    if (host.endsWith('bloomberg.com')) return 74;
    if (host.endsWith('reuters.com')) return 73;
    if (host.endsWith('ft.com') || host.endsWith('ftacademy.cn')) return 72;
    if (host.endsWith('nytimes.com') || host.endsWith('wsj.com')) return 71;
    if (
      host.startsWith('www.') &&
      !host.endsWith('blogspot.com') &&
      !host.endsWith('wordpress.com')
    ) return 65; // likely company site or established org
    return 50;
  } catch {
    return 0;
  }
}

function sortSourcesByAuthority(sources: SourceAttribution[]): SourceAttribution[] {
  return [...sources].sort((a, b) => getAuthorityScore(b.url) - getAuthorityScore(a.url));
}

const EnrichmentSchema = z.object({
  intent: z.enum(['boolean', 'specific', 'contextual']),
  variables: z.array(z.object({
    subject: z.object({
      name: z.string(),
      type: z.string(),
      canonical_id: z.string().optional()
    }),
    name: z.string(),
    type: z.enum(['boolean', 'string', 'number', 'date', 'url', 'text']),
    value: z.union([z.boolean(), z.number(), z.string()]).nullable(),
    confidence: z.number().min(0).max(1).default(0.5),
    sources: z.array(z.object({
      title: z.string().nullable(),
      url: z.string(),
      snippet: z.string().nullable()
    })).default([]),
    observed_at: z.string().optional()
  })).default([]),
  notes: z.string().nullable()
});

async function finalizeResult(
  raw: string, 
  intent: EnrichmentResult['intent'], 
  web: { title?: string; url: string; snippet?: string; content?: string }[],
  defaultSubject?: { name: string; type: string }
): Promise<EnrichmentResult> {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { intent, variables: [], notes: 'LLM returned non-JSON; using fallback.' } as EnrichmentResult;
  }

  const variables: MagicVariableValue[] = [];
  const now = new Date().toISOString();

  for (const v of Array.isArray(parsed?.variables) ? parsed.variables : []) {
    // Ensure subject is present
    let subject = v.subject;
    if (!subject && defaultSubject) {
      // Resolve entity for default subject
      const entityId = await resolveEntity(defaultSubject.name, defaultSubject.type);
      subject = {
        name: defaultSubject.name,
        type: defaultSubject.type,
        canonical_id: entityId
      };
    } else if (subject && !subject.canonical_id) {
      // Resolve canonical_id if not provided
      const entityId = await resolveEntity(subject.name, subject.type);
      subject = {
        ...subject,
        canonical_id: entityId
      };
    }

    if (!subject) {
      console.warn(`Skipping variable ${v.name} - missing subject`);
      continue;
    }

    const variable: MagicVariableValue = {
      subject,
      name: v.name,
      type: v.type,
      value: v.value,
      confidence: typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 ? v.confidence : 0.5,
      sources: Array.isArray(v.sources) ? sortSourcesByAuthority(dedupeByUrl(v.sources)) : [],
      observed_at: v.observed_at || now
    };

    variables.push(variable);
  }

  if (variables.length === 0 && defaultSubject) {
    // Fallback context variable
    const entityId = await resolveEntity(defaultSubject.name, defaultSubject.type);
    variables.push({
      subject: {
        name: defaultSubject.name,
        type: defaultSubject.type,
        canonical_id: entityId
      },
      name: 'context',
      type: 'text',
      value: web.map((r: any) => `${r.title ?? r.url}:\n${(r.content ?? r.snippet ?? '').trim()}`).join('\n\n'),
      confidence: 0.4,
      sources: web.map((r: any) => ({ title: r.title, url: r.url, snippet: (r.content ?? r.snippet) ? String(r.content ?? r.snippet).slice(0, 1000) : undefined })),
      observed_at: now
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
      temperature: 1,
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

function needsTwoAgreeingSources(variable: MagicVariableValue): boolean {
  const type = variable.type;
  const name = variable.name.toLowerCase();
  if (type === 'date' || type === 'number' || type === 'string') return true;
  if (name.includes('found') && name.includes('date')) return true;
  return false;
}

function validateCitations(variables: MagicVariableValue[], evidencePolicy?: { minCorroboration: number; requireAuthority: boolean }): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const minCorroboration = evidencePolicy?.minCorroboration ?? 1;
  const requireAuthority = evidencePolicy?.requireAuthority ?? false;
  
  for (const v of variables) {
    const srcCount = Array.isArray(v.sources) ? v.sources.length : 0;
    if (srcCount < minCorroboration) {
      issues.push(`Variable "${v.name}" requires at least ${minCorroboration} source${minCorroboration > 1 ? 's' : ''}.`);
    }
    if (needsTwoAgreeingSources(v) && srcCount < 2) {
      issues.push(`Variable "${v.name}" requires at least two agreeing sources (date/number/string).`);
    }
    if (requireAuthority && srcCount > 0) {
      const hasAuthority = v.sources.some(s => getAuthorityScore(s.url) >= 70);
      if (!hasAuthority) {
        issues.push(`Variable "${v.name}" requires at least one high-authority source (authority score >= 70).`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export async function runAgent(query: string, expectedVars: MagicVariableDefinition[], sessionId?: string, username?: string, entity?: string): Promise<EnrichmentResult> {
  const baseModel = getDefaultLlm()
  const { intent, target } = await classifyIntent(baseModel, query);

  // Run inference router to get priors and constraints
  const routerOut = await inferContext({ query, expectedVars, entity });

  // Determine default subject from entity parameter
  const defaultSubjectName = entity || 'Unknown Entity';
  const defaultSubjectType = routerOut.entityTypePrior && Object.keys(routerOut.entityTypePrior).length > 0
    ? Object.entries(routerOut.entityTypePrior).sort((a, b) => b[1] - a[1])[0][0]
    : 'company';

  const schemaText = `
{
  "intent": "${intent}",
  "variables": [
    {
      "subject": {
        "name": string,        -- The name of the entity (company/person/etc.)
        "type": string,         -- "company" | "person" | etc.
        "canonical_id": string  -- Optional: will be auto-generated if not provided
      },
      "name": string,
      "type": "boolean"|"string"|"number"|"date"|"url"|"text",
      "value": any,
      "confidence": number,
      "sources": [{"title": string|optional, "url": string, "snippet": string|optional}],
      "observed_at": string|optional  -- ISO timestamp
    }
  ],
  "notes": string|optional
}

IMPORTANT: Every variable MUST include a "subject" object. The subject should be the entity (company/person/etc.) that the variable is about. If not specified, default to: ${JSON.stringify({ name: defaultSubjectName, type: defaultSubjectType })}`;
  const expectedNames = expectedVars.map(v => v.name).join(', ');
  const expectedHint = expectedNames ? `Aim to fill these variables if possible: ${expectedNames}.` : '';

  const sid = sessionId || 'default_research';
  const history = getHistory(sid);

  const trustedFacts = entity ? await getTrustedFactsForEntity(entity) : {};

  // Build entity type context from router priors
  const topEntityTypes = Object.entries(routerOut.entityTypePrior)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .filter(([_, prob]) => prob > 0.1)
    .map(([type, prob]) => `${type} (${(prob * 100).toFixed(0)}%)`)
    .join(', ');
  
  const vocabContext = routerOut.vocabHints.boost.length > 0
    ? `\n- Contextual vocabulary hints: Boost relevance for terms like: ${routerOut.vocabHints.boost.join(', ')}`
    : '';
  
  const entityTypeContext = topEntityTypes
    ? `\n- Most likely entity types: ${topEntityTypes}`
    : '';

  // Inject current date into system prompt
  const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const currentDateReadable = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  const system = `You are a careful research agent.

Current date: ${currentDateReadable} (${currentDate}). Use this to interpret relative time references and understand what information might be outside your training data.

Important: For information outside your training data cutoff or for recent/current events, you MUST gather outside information using the available tools (web_search, latest_finder, knowledge_query). Do not rely solely on your training knowledge for recent or specific factual information.

- Before consulting external sources, first check whether there are stored facts about the specific entity. If you do not have an entity name yet, skip internal knowledge and search externally instead.
- Search the web only when needed (for missing or more recent information).
- Reconcile conflicting sources. Prefer (recent + authoritative) over isolated social posts.
- When you encounter conflicting claims or uncertain information, assess plausibility using common sense and world knowledge.
- Before searching the web, ensure the query directly contains key terms from the user's request/entity/expected variables. Do NOT search for generic placeholders (e.g., "input", "query"). If you cannot formulate a relevant query, do not search.
- If evidence conflicts, lower confidence and summarize the disagreement.
- Citations-required: For every factual variable, include at least ${routerOut.evidencePolicy.minCorroboration} source${routerOut.evidencePolicy.minCorroboration > 1 ? 's' : ''}. For date/number/string, prefer at least two agreeing authoritative sources.${routerOut.evidencePolicy.requireAuthority ? ' Require at least one high-authority source (Wikidata, Wikipedia, SEC, company site, major news).' : ''}
- Authority ranking: Prefer Wikidata/Wikipedia/company site/SEC over low-authority blogs.
- Grounded finalization: Base answers ONLY on provided tool outputs or trusted facts. Do not fabricate.
- Low-confidence refusal: If sources are weak or disagree, set value to null and explain uncertainty in notes.
- Output ONLY final JSON strictly matching the provided schema. No markdown, no prose.${entityTypeContext}${vocabContext}
Routing:
- Use tools only when needed to satisfy the query; otherwise answer from context.
- If the user uses a pronoun and no entity is set then ask: "Who are you referring to?" and stop.
- For "latest/last" questions, ensure results are chronologically sorted and verified across ≥2 sources. 
- For "latest/last" questions, ensure that you search for a more recent example. Only stop searching when you are unable to find a newer one.
Policies:
- Cite sources for all factual claims.
- If any required field is missing, return an ask_clarification action.
- On tool errors, surface a concise explanation and retry once with safer params.
`;

  const trustedFactsText = Object.values(trustedFacts).length
    ? `Trusted facts provided for entity "${entity}":\n${Object.values(trustedFacts).map(f => `- ${f.field}: ${String(f.value)} (source: ${f.source ?? 'user'})`).join('\n')}`
    : '';

  const intro = new HumanMessage(
    `User query: ${query}
User intent target (may be empty): ${target ?? ''}

${expectedHint}

${trustedFactsText}

Schema to follow for FINAL answer (no markdown, JSON only):
${schemaText}`
  );

  const messages: any[] = [new SystemMessage(system), ...(await history.getMessages()), intro];

  let webResults: { title?: string; url: string; snippet?: string; content?: string }[] = [];
  const MAX_STEPS = Number(process.env.RESEARCH_MAX_STEPS || 6);
  let steps = 0;
  let finalRaw = '';
  const relevantTokens = buildRelevantTokens(query, expectedVars, routerOut, entity, target);

  while (steps < MAX_STEPS) {
    steps += 1;
    const ai = await baseModel.invoke(messages);
    messages.push(ai);
    


    const toolCalls = (ai as AIMessage).tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Model decided to produce a final answer; validate citations and requirements
      await history.addMessage(ai);
      const candidate = typeof ai.content === 'string' ? ai.content : '';
      let parsed: any = null;
      try { parsed = JSON.parse(candidate); } catch {}
      if (parsed && Array.isArray(parsed.variables)) {
        // Ensure all variables have subjects (add default if missing)
        for (const v of parsed.variables) {
          if (!v.subject && defaultSubjectName !== 'Unknown Entity') {
            v.subject = {
              name: defaultSubjectName,
              type: defaultSubjectType
            };
          }
        }
        
        // Filter variables based on attribute constraints
        const allowedVars = (parsed.variables as any[]).filter((v: any) => {
          const constraint = routerOut.attrConstraints[v.name];
          return constraint !== 'forbidden' && v.subject; // Must have subject
        });
        
        // Update parsed variables to only include allowed ones
        parsed.variables = allowedVars;
        
        // Validate that variables have subjects and citations
        const validationIssues: string[] = [];
        for (const v of allowedVars) {
          if (!v.subject || !v.subject.name) {
            validationIssues.push(`Variable "${v.name}" is missing required subject.`);
          }
        }
        
        if (validationIssues.length === 0) {
          const check = validateCitations(allowedVars as MagicVariableValue[], routerOut.evidencePolicy);
          if (!check.ok && steps < MAX_STEPS) {
            const nudge = new HumanMessage(
              `Verification gate not satisfied:\n- ${check.issues.join('\n- ')}\nIf needed, run another web_search to gather corroborating sources, then return ONLY the corrected final JSON.`
            );
            messages.push(nudge);
            await history.addUserMessage(nudge.content as string);
            // continue loop to allow tools or final correction
            continue;
          }
        } else if (steps < MAX_STEPS) {
          const nudge = new HumanMessage(
            `Required fields missing:\n- ${validationIssues.join('\n- ')}\nPlease ensure every variable includes a subject object with "name" and "type" fields, then return ONLY the corrected final JSON.`
          );
          messages.push(nudge);
          await history.addUserMessage(nudge.content as string);
          continue;
        }
        
        // Update candidate with filtered variables
        finalRaw = JSON.stringify(parsed);
      } else {
        finalRaw = candidate;
      }
      break;
    }

    const pendingToolMsgs: ToolMessage[] = [];
    for (const tc of toolCalls) {
      let result: string = '';
      try {
        const argsStr = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? '');
        if (tc.name === 'web_search') {
          console.log("web_search");
          let proposed = argsStr;
          try {
            const parsed = JSON.parse(argsStr);
            if (typeof parsed?.query === 'string') proposed = parsed.query;
            else if (typeof parsed?.input === 'string') proposed = parsed.input;
            else if (typeof parsed === 'string') proposed = parsed;
          } catch {
            // keep argsStr
          }
          const guard = isIrrelevantWebQuery(proposed, relevantTokens);
          if (guard.irrelevant) {
            result = JSON.stringify({ error: 'Blocked irrelevant web_search', query: proposed, reason: guard.reason });
          } else {
            result = String(await webSearchTool.invoke(argsStr));
          }
          try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed)){
                webResults = [...webResults, ...parsed];
            }
          } catch {
            // ignore parse issues
          }
        } else if (tc.name === 'evaluate_plausibility') {
          console.log("evaluate_plausability");
          result = String(await plausibilityCheckTool.invoke(argsStr));
          console.log(result)
        } else if (tc.name === 'knowledge_query') {
          console.log("knowledge_query");
          result = String(await knowledgeQueryTool.invoke(argsStr));
          console.log(result);
        } else if (tc.name === 'latest_finder') {
          console.log("latest_finder");
          console.log(argsStr);
          result = String(await latestFinderTool.invoke(argsStr));
          console.log(result);
        } else {
          result = JSON.stringify({ error: `Unknown tool: ${tc.name}` });
        }
      } catch (e: any) {
        result = JSON.stringify({ error: e?.message ?? 'Tool execution failed' });
      }


      const toolMsg = new ToolMessage({
        tool_call_id: String(tc.id ?? ''),
        content: result
      });
      messages.push(toolMsg);
      pendingToolMsgs.push(toolMsg);

      // Nudge the model to pass proper arguments if plausibility tool was misused
      if (tc.name === 'evaluate_plausibility') {
        try {
          const parsedErr = JSON.parse(result);
          if (parsedErr?.error === 'No claims provided') {
            const nudge = new HumanMessage(
              'The evaluate_plausibility tool requires JSON like {"claims":["claim A","claim B"],"context":"..."}. ' +
              'Extract specific conflicting claims from your current sources and call evaluate_plausibility again with those claims.'
            );
            messages.push(nudge);
            await history.addUserMessage(nudge.content as string);
          }
        } catch {}
      }
    }

    // Persist assistant and all tool results together, in order
    await history.addMessage(ai);
    for (const tm of pendingToolMsgs) {
      await history.addMessage(tm);
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

  const defaultSubject = entity ? { name: entity, type: defaultSubjectType } : undefined;
  let result = await finalizeResult(normalized, intent, webResults, defaultSubject);
  console.log(result);

  // Apply trusted facts overrides when available
  if (entity && Object.values(trustedFacts).length) {
    for (const v of result.variables) {
      const tf = (trustedFacts as any)[v.name];
      if (tf && tf.value !== undefined) {
        v.value = tf.value as any;
        v.confidence = 1.0;
        const tfSource: SourceAttribution = tf.source ? { title: undefined, url: tf.source, snippet: undefined } : { title: 'Trusted user fact', url: 'about:trusted-fact', snippet: undefined };
        v.sources = dedupeByUrl([tfSource, ...v.sources]);
      }
    }
  }

  // Store facts for all variables
  try {
    for (const variable of result.variables) {
      // Skip context variables or variables without proper subjects
      if (variable.name === 'context' || !variable.subject || !variable.subject.canonical_id) {
        continue;
      }
      
      const observedAt = variable.observed_at ? new Date(variable.observed_at) : undefined;
      await storeFact(variable, observedAt);
    }
  } catch (error) {
    console.error('Failed to store facts:', error);
    // Don't fail the entire request if fact storage fails
  }
  console.log(result);

  return result;
}
// server/src/services/researchAgent.ts
import { EnrichmentResult, MagicVariableDefinition, MagicVariableValue, SourceAttribution } from '../types.js';
import { classifyIntent } from './intent.js';
import { getDefaultLlm } from './providers.js';
import { webSearchTool } from '../tools/webSearch.js';
import { ChatOpenAI } from '@langchain/openai';
import { getHistory, trimHistory } from './memory.js';
import { addMemory } from './longTermMemory.js';
import { Fact, getFactsForEntity, storeFact } from './factsStore.js';
import { resolveEntity, tryResolveExistingEntity } from './entityResolver.js';
import { z } from 'zod';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { plausibilityCheckTool } from '../tools/plausibilityCheck.js';
import { knowledgeQueryTool } from '../tools/knowledgeQuery.js';
import { latestFinderTool } from '../tools/latestFinder.js';
import { inferContext } from './inferenceRouter.js';

type ResearchIntensity = 'low' | 'medium' | 'high';

const INTENSITY_CONFIG: Record<ResearchIntensity, { maxIterations: number; maxWebSearches: number }> = {
  low: { maxIterations: 3, maxWebSearches: 2 },
  medium: { maxIterations: 6, maxWebSearches: 4 },
  high: { maxIterations: 10, maxWebSearches: 8 }
} as const;

function getIntensityCaps(intensity: ResearchIntensity): { maxIterations: number; maxWebSearches: number } {
  const base = INTENSITY_CONFIG[intensity];
  const envMaxSteps = Number(process.env.RESEARCH_MAX_STEPS);
  const envMaxWeb = Number(process.env.RESEARCH_MAX_WEB_SEARCHES);
  const cappedSteps = Number.isFinite(envMaxSteps) && envMaxSteps > 0 ? Math.min(base.maxIterations, envMaxSteps) : base.maxIterations;
  const cappedWeb = Number.isFinite(envMaxWeb) && envMaxWeb > 0 ? Math.min(base.maxWebSearches, envMaxWeb) : base.maxWebSearches;
  return { maxIterations: cappedSteps, maxWebSearches: cappedWeb };
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
    ) return 65; 
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
}).strict();

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
    let subject = v.subject;
    if (!subject && defaultSubject) {
      const entityId = await resolveEntity(defaultSubject.name, defaultSubject.type);
      subject = {
        name: defaultSubject.name,
        type: defaultSubject.type,
        canonical_id: entityId
      };
    } else if (subject && !subject.canonical_id) {
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
  } catch {}
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

export async function runAgent(query: string, expectedVars: MagicVariableDefinition[], sessionId?: string, username?: string, entity?: string, researchIntensity: ResearchIntensity = 'medium'): Promise<EnrichmentResult> {
  const baseModel = getDefaultLlm()
  const { intent, target } = await classifyIntent(baseModel, query);

  const routerOut = await inferContext({ query, expectedVars, entity });

  const defaultSubjectName = entity || 'Unknown Entity';
  const defaultSubjectType = routerOut.entityType || 'organization';

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

  let trustedFacts: Fact[] = [];
  if (entity) {
    const resolved = await tryResolveExistingEntity(entity);
    if (resolved) {
      trustedFacts = await getFactsForEntity(resolved.id);
    }
  }

  const vocabContext = routerOut.vocabHints.boost.length > 0
    ? `\n- Contextual vocabulary hints: Boost relevance for terms like: ${routerOut.vocabHints.boost.join(', ')}`
    : '';
  
  const entityTypeContext = routerOut.entityType
    ? `\n- Most likely entity type: ${routerOut.entityType}`
    : '';

  const currentDate = new Date().toISOString().split('T')[0];
  const currentDateReadable = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  const { maxIterations, maxWebSearches } = getIntensityCaps(researchIntensity);
  const intensityNudge = researchIntensity === 'low'
    ? '- Intensity: Low. Be frugal with external tool calls; prefer quick reasoning.'
    : researchIntensity === 'high'
      ? '- Intensity: High. Exhaustively corroborate facts; use more external sources as needed.'
      : '- Intensity: Medium. Balance speed with corroboration.';

  const system = `You are a careful research agent.

Current date: ${currentDateReadable} (${currentDate}). Use this to interpret relative time references and understand what information might be outside your training data.

Important: For information outside your training data cutoff or for recent/current events, you MUST gather outside information using the available tools (web_search, latest_finder, knowledge_query). Do not rely solely on your training knowledge for recent or specific factual information.
IMPORTANT CONTRACT:
- You MUST obey tool parameter names and types exactly.
- Do not invent parameters not in the schema.
- If a tool call is rejected with SCHEMA_VALIDATION_ERROR, repair the call and try again.
IMPORTANT: Make sure to call tools with the proper keys. These are described in the tool descriptions
- Before consulting external sources, first check whether there are stored facts about the specific entity. If you do not have an entity name yet, skip internal knowledge and search externally instead.
- Search the web only when needed (for missing or more recent information).
- Reconcile conflicting sources. Prefer (recent + authoritative) over isolated social posts.
- When you encounter conflicting claims or uncertain information, assess plausibility using common sense and world knowledge.
${intensityNudge}
- You will periodically receive a "tool_outcomes" JSON from the user. Treat entries in "do_not_retry" as blocked: do not repeat those exact calls unless arguments are materially changed. Prefer calls similar to those listed in "success".
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

  const trustedFactsText = trustedFacts.length
    ? `Trusted facts provided for entity "${entity}":\n${trustedFacts.map(f => `- ${f.name}: ${String(f.value)} (source: ${f.sources && f.sources.length > 0 ? f.sources[0].url : 'user'})`).join('\n')}`
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
  const MAX_STEPS = maxIterations;
  let steps = 0;
  let webSearchCount = 0;
  let finalRaw = '';
  
  
  const toolUseRegistry = new Set<string>();
  const toolResultCache = new Map<string, string>();

  function willRunTool(name: string, args: any): { allowed: boolean; fp: string } {
    const sortedKeys = Object.keys(args).sort();
    const sortedObj: any = {};
    for (const key of sortedKeys) {
      sortedObj[key] = args[key];
    }
    const fp = `${name}:${JSON.stringify(sortedObj)}`;
    if (toolUseRegistry.has(fp)) {
      return { allowed: false, fp };
    }
    toolUseRegistry.add(fp);
    return { allowed: true, fp };
  }

  function canonArgs(obj: any): any {
    const keys = Object.keys(obj || {}).sort();
    const out: any = {};
    for (const k of keys) out[k] = obj[k];
    return out;
  }

  function isFailedOrEmptyResult(toolName: string, result: string): boolean {
    if (typeof result !== 'string') return true;
    const lower = result.toLowerCase();
    if (lower.includes('schema_validation_error') || lower.includes('tool_execution_error')) return true;
    if (lower.includes('error') || lower.includes('blocked') || lower.includes('limit')) return true;
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object' && parsed.error) return true;
      if ((toolName === 'web_search' || toolName === 'latest_finder') && Array.isArray(parsed)) {
        if (parsed.length === 0) return true;
        const hasSignal = parsed.some((it: any) => it && ((it.url && it.url !== 'about:blank') || (it.title && String(it.title).trim()) || (it.snippet && String(it.snippet).trim())));
        return !hasSignal;
      }
      if (toolName === 'knowledge_query') {
        if (Array.isArray(parsed) && parsed.length === 0) return true;
        if (typeof parsed === 'string' && (parsed.trim() === '' || parsed.toLowerCase().includes('no results'))) return true;
      }
    } catch {
      if (result.trim() === '' || lower.includes('error')) return true;
    }
    return false;
  }

  while (steps < MAX_STEPS) {
    steps += 1;
    const ai = await baseModel.invoke(messages);
    messages.push(ai);
    

    const toolCalls = (ai as AIMessage).tool_calls ?? [];
    if (toolCalls.length === 0) {
      await history.addMessage(ai);
      const candidate = typeof ai.content === 'string' ? ai.content : '';
      let parsed: any = null;
      try { parsed = JSON.parse(candidate); } catch {}
      if (parsed && Array.isArray(parsed.variables)) {
        for (const v of parsed.variables) {
          if (!v.subject && defaultSubjectName !== 'Unknown Entity') {
            v.subject = {
              name: defaultSubjectName,
              type: defaultSubjectType
            };
          }
        }
        
        const allowedVars = (parsed.variables as any[]).filter((v: any) => {
          const constraint = routerOut.attrConstraints[v.name];
          return constraint !== 'forbidden' && v.subject; 
        });
        
        parsed.variables = allowedVars;
        
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
        
        finalRaw = JSON.stringify(parsed);
      } else {
        finalRaw = candidate;
      }
      break;
    }

    const pendingToolMsgs: ToolMessage[] = [];
    const failedToolCalls: Array<{ tool: string; args: any; reason: string; fingerprint: string }> = [];
    const successfulToolCalls: Array<{ tool: string; args: any; fingerprint: string; quality?: string }> = [];
    for (const tc of toolCalls) {
      let result: string = '';
      const toolName = String(tc.name);
      const callId = String(tc.id ?? '');
      let argsObj: any = {};
      try {
        argsObj = typeof tc.args === 'string' ? JSON.parse(tc.args) : (tc.args ?? {});
      } catch { argsObj = {}; }

      const { allowed, fp } = willRunTool(toolName, argsObj);
      if (!allowed) {
        const cachedResult = toolResultCache.get(fp);
        if (cachedResult) {
          result = cachedResult;
          console.log(`Reusing cached result for duplicate tool call: ${toolName}`);
          if (isFailedOrEmptyResult(toolName, result)) {
            failedToolCalls.push({ tool: toolName, args: canonArgs(argsObj), reason: 'duplicate (cached failed/empty)', fingerprint: fp });
          }
        } else {
          result = JSON.stringify({ 
            error: 'Duplicate tool call blocked', 
            tool: toolName, 
            message: 'This exact tool call was already executed in this session' 
          });
          console.log(`Blocked duplicate tool call: ${toolName}`);
          failedToolCalls.push({ tool: toolName, args: canonArgs(argsObj), reason: 'duplicate blocked', fingerprint: fp });
        }
      } else {
        // Execute the tool (existing logic)
        try {
          if (toolName === 'web_search') {
            console.log('web_search');
            try { console.log(JSON.stringify(argsObj)); } catch { console.log(String(argsObj)); }
            const proposed = typeof argsObj?.query === 'string' ? String(argsObj.query) : '';
            if (proposed && webSearchCount >= maxWebSearches) {
              result = JSON.stringify({ error: 'Web search limit reached', limit: maxWebSearches });
              console.log(result);
            } else {
              result = String(await webSearchTool.invoke(argsObj));
              console.log(result);
              try {
                const maybeErr = JSON.parse(result);
                if (!maybeErr || !maybeErr.error) webSearchCount += 1;
              } catch {
                webSearchCount += 1;
              }
            }
            try {
              const parsed = JSON.parse(result);
              if (Array.isArray(parsed)) {
                webResults = [...webResults, ...parsed];
              }
            } catch {}
          } else if (toolName === 'evaluate_plausibility') {
            console.log('evaluate_plausibility');
            try { console.log(JSON.stringify(argsObj)); } catch { console.log(String(argsObj)); }
            result = String(await plausibilityCheckTool.invoke(argsObj));
            try { console.log(result); } catch {}
          } else if (toolName === 'knowledge_query') {
            console.log('knowledge_query');
            try { console.log(JSON.stringify(argsObj)); } catch { console.log(String(argsObj)); }
            result = String(await knowledgeQueryTool.invoke(argsObj));
            try { console.log(result); } catch {}
          } else if (toolName === 'latest_finder') {
            console.log('latest_finder');
            try { console.log(JSON.stringify(argsObj)); } catch { console.log(String(argsObj)); }
            if (webSearchCount >= maxWebSearches) {
              result = JSON.stringify({ error: 'Web search limit reached', limit: maxWebSearches });
            } else {
              result = String(await latestFinderTool.invoke(argsObj));
              try {
                const maybeErr = JSON.parse(result);
                if (!maybeErr || !maybeErr.error) webSearchCount += 1;
              } catch {
                webSearchCount += 1;
              }
            }
          } else {
            result = JSON.stringify({ error: `Unknown tool: ${toolName}` });
          }
          
          // Cache the result for potential reuse
          toolResultCache.set(fp, result);
          if (isFailedOrEmptyResult(toolName, result)) {
            let reason = 'empty/failed';
            try {
              const parsed = JSON.parse(result);
              if (parsed?.error) reason = String(parsed.error);
              if (Array.isArray(parsed) && parsed.length === 0) reason = 'empty results';
            } catch {}
            failedToolCalls.push({ tool: toolName, args: canonArgs(argsObj), reason, fingerprint: fp });
          } else {
            let quality: string | undefined;
            try {
              const parsed = JSON.parse(result);
              if (Array.isArray(parsed)) quality = `${parsed.length} hits`;
            } catch {}
            successfulToolCalls.push({ tool: toolName, args: canonArgs(argsObj), fingerprint: fp, quality });
          }
        } catch (e: any) {
          const errText = (e?.name === 'ZodError' || String(e?.message || '').includes('Invalid input'))
            ? `SCHEMA_VALIDATION_ERROR: ${e?.message ?? 'invalid arguments'}`
            : `TOOL_EXECUTION_ERROR: ${e?.message ?? 'failed'}`;
          result = errText;
          failedToolCalls.push({ tool: toolName, args: canonArgs(argsObj), reason: errText, fingerprint: fp });
        }
      }

      const toolMsg = new ToolMessage({ tool_call_id: callId, content: result });
      messages.push(toolMsg);
      pendingToolMsgs.push(toolMsg);

      if (toolName === 'evaluate_plausibility' && typeof result === 'string' && result.startsWith('SCHEMA_VALIDATION_ERROR')) {
        const nudge = new HumanMessage(
          'The evaluate_plausibility tool requires JSON like {"claims":["claim A","claim B"],"context":"..."}. Extract specific conflicting claims and call the tool again with valid parameters.'
        );
        messages.push(nudge);
        await history.addUserMessage(nudge.content as string);
      }
    }

    await history.addMessage(ai);
    for (const tm of pendingToolMsgs) {
      await history.addMessage(tm);
    }

    if ((failedToolCalls.length > 0 || successfulToolCalls.length > 0) && steps < MAX_STEPS) {
      const outcomes = {
        success: successfulToolCalls.slice(-3).map(s => ({ tool: s.tool, args: s.args, fp: s.fingerprint, quality: s.quality })),
        do_not_retry: failedToolCalls.slice(-5).map(f => ({ tool: f.tool, args: f.args, fp: f.fingerprint, reason: f.reason }))
      };
      const nudge = new HumanMessage(
        `tool_outcomes:\n${JSON.stringify(outcomes)}\n` +
        `Rules: Do not repeat any exact call in do_not_retry. If needed, materially change arguments (e.g., query terms, filters).`
      );
      messages.push(nudge);
      await history.addUserMessage(nudge.content as string);
    }

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


  let normalized: string = finalRaw;
  try {
    const parsed = JSON.parse(finalRaw);
    const safe = EnrichmentSchema.safeParse(parsed);
    normalized = JSON.stringify(safe.success ? safe.data : parsed);
  } catch {}

  const defaultSubject = entity ? { name: entity, type: defaultSubjectType } : undefined;
  let result = await finalizeResult(normalized, intent, webResults, defaultSubject);
  console.log(result);

  if (entity && trustedFacts.length > 0) {
    for (const v of result.variables) {
      const tf = trustedFacts.find(f => f.name === v.name);
      if (tf && tf.value !== undefined) {
        const trustedConfidence = tf.confidence ?? 0;
        const researchConfidence = v.confidence ?? 0;
        
        if (trustedConfidence >= researchConfidence) {
          v.value = tf.value as any;
          v.confidence = trustedConfidence;
          const tfSource: SourceAttribution = tf.sources && tf.sources.length > 0 
            ? { title: tf.sources[0].title, url: tf.sources[0].url, snippet: tf.sources[0].snippet }
            : { title: 'Trusted user fact', url: 'about:trusted-fact', snippet: undefined };
          v.sources = dedupeByUrl([tfSource, ...v.sources]);
        }
      }
    }
  }

  try {
    for (const variable of result.variables) {
      if (variable.name === 'context' || !variable.subject || !variable.subject.canonical_id) {
        continue;
      }
      const observedAt = variable.observed_at ? new Date(variable.observed_at) : undefined;
      await storeFact(variable, observedAt);
    }
  } catch (error) {
    console.error('Failed to store facts:', error);
  }
  console.log(result);

  return result;
}
import { DynamicTool } from '@langchain/core/tools';
import { getFact, getFactsForEntity, findSimilarFactNames } from '../services/factsStore.js';
import { runAgent } from '../services/researchAgent.js';
import { tryResolveExistingEntity, searchEntitiesByName } from '../services/entityResolver.js';


export const knowledgeQueryTool = new DynamicTool({
  name: 'knowledge_query',
  description: `Query structured facts about known entities (companies, people, orgs). 
Input should be JSON with:
- "entity": string (required) - The name of the entity to query
- "variable_name": string (optional) - If provided, returns only the specific fact with this name
- "question": string (optional) - If provided and variable_name is not set, filters facts by relevance to this question

Returns JSON with fact data including name, value, confidence, sources, and observed_at.`,
  func: async (input: string) => {
    let entity: string | undefined;
    let variable_name: string | undefined;
    let question: string | undefined;

    try {
      const parsed = JSON.parse(input);
      entity = typeof parsed?.entity === 'string' ? parsed.entity : undefined;
      variable_name = typeof parsed?.variable_name === 'string' ? parsed.variable_name : undefined;
      question = typeof parsed?.question === 'string' ? parsed.question : undefined;
    } catch {
      // If not JSON, try to treat input as entity name
      const trimmed = input.trim();
      if (trimmed) {
        entity = trimmed;
      }
    }

    if (!entity) {
      return JSON.stringify({
        error: 'Entity name is required',
        hint: 'Pass JSON like EXAMPLE :{"entity": "Apple Inc", "variable_name": "ceo_name"} or just a plain entity name string.'
      });
    }

    try {
      // 1️⃣ Resolve existing entity without creating a new record
      const resolved = await tryResolveExistingEntity(entity);
      if (!resolved) {
        const candidates = await searchEntitiesByName(entity, 5);
        return JSON.stringify({
          code: 'ENTITY_UNRESOLVED',
          error: 'Could not resolve entity',
          entity_query: entity,
          suggestions: candidates.map((c: any) => ({ id: c.id, name: c.name, type: c.type, score: c.score }))
        });
      }
      const entityId = resolved.id;

      // 2️⃣ If a specific variable is requested
      if (variable_name) {
        const tryReturn = (f: any, original?: string, note?: string) => JSON.stringify({
          entity,
          entity_id: entityId,
          variable_name: f.name,
          original_query: original ?? undefined,
          value: f.value,
          dtype: f.dtype,
          confidence: f.confidence,
          sources: f.sources,
          observed_at: f.observed_at.toISOString(),
          valid_from: f.valid_from.toISOString(),
          note
        });

        let fact = await getFact(entityId, variable_name);

        // Try synonyms if cache miss
        if (!fact) {
          const synonyms = await findSimilarFactNames(entityId, variable_name);
          for (const syn of synonyms) {
            const f = await getFact(entityId, syn);
            if (f) return tryReturn(f, variable_name, `Found using synonym mapping from "${variable_name}"`);
          }
        }

        // Still not found → trigger web/search pipeline, persist, then answer
        if (!fact) {
          const researchQuery = `${entity} ${variable_name}`;
          try {
            await runAgent(researchQuery, [{ name: variable_name }], undefined, undefined, entity);
          } catch {
            // swallow; will attempt to read from DB anyway
          }

          // Try again for exact and synonyms
          fact = await getFact(entityId, variable_name);
          if (!fact) {
            const synonyms = await findSimilarFactNames(entityId, variable_name);
            for (const syn of synonyms) {
              const f = await getFact(entityId, syn);
              if (f) return tryReturn(f, variable_name, 'Fetched via web/search pipeline');
            }
          }
        }

        if (!fact) {
          return JSON.stringify({
            entity,
            entity_id: entityId,
            variable_name,
            error: 'No fact found after web search'
          });
        }

        return tryReturn(fact);
      }

      // 3️⃣ Otherwise get all facts for the entity
      const facts = await getFactsForEntity(entityId);
      
      // If question is provided, filter facts by name relevance (simple text matching)
      let filtered = facts;
      if (question && question.trim()) {
        const questionLower = question.toLowerCase();
        const questionWords = questionLower.split(/\s+/).filter(w => w.length > 2);
        
        filtered = facts.filter(fact => {
          const factNameLower = fact.name.toLowerCase();
          // Check if any question word appears in the fact name
          return questionWords.some(word => factNameLower.includes(word)) ||
                 factNameLower.includes(questionLower) ||
                 questionLower.includes(factNameLower);
        });
        
        // If no matches, return all facts but indicate the filter was applied
        if (filtered.length === 0) {
          filtered = facts; // Fall back to all facts
        }
      }

      // Limit to top 10 facts
      const limited = filtered.slice(0, 10);

      return JSON.stringify({
        entity,
        entity_id: entityId,
        facts: limited.map(fact => ({
          name: fact.name,
          value: fact.value,
          dtype: fact.dtype,
          confidence: fact.confidence,
          sources: fact.sources,
          observed_at: fact.observed_at.toISOString(),
          valid_from: fact.valid_from.toISOString()
        })),
        total_found: filtered.length,
        returned: limited.length
      });
    } catch (error: any) {
      return JSON.stringify({
        error: error?.message || 'Failed to query knowledge',
        entity
      });
    }
  }
});


import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getFact, getFactsForEntity, findSimilarFactNames } from '../services/factsStore.js';
import { runAgent } from '../services/researchAgent.js';
import { tryResolveExistingEntity, searchEntitiesByName } from '../services/entityResolver.js';

class KnowledgeQueryTool extends StructuredTool {
  name = 'knowledge_query';
  description = `Query structured facts about known entities (companies, people, orgs).
Input MUST be valid JSON with:
- "entity": string (required) - The name of the entity to query
- "variable_name": string (optional) - If provided, returns only the specific fact with this name
- "question": string (optional) - If provided and variable_name is not set, filters facts by relevance to this question

Returns JSON with fact data including name, value, confidence, sources, and observed_at.`;
  schema = z.object({
    entity: z.string().min(1, 'entity is required'),
    variable_name: z.string().min(1).optional(),
    question: z.string().min(1).optional()
  }).strict();

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    const { entity, variable_name, question } = input;
    try {
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
        if (!fact) {
          const synonyms = await findSimilarFactNames(entityId, variable_name);
          for (const syn of synonyms) {
            const f = await getFact(entityId, syn);
            if (f) return tryReturn(f, variable_name, `Found using synonym mapping from "${variable_name}"`);
          }
        }

        if (!fact) {
          const researchQuery = `${entity} ${variable_name}`;
          try {
            await runAgent(researchQuery, [{ name: variable_name }], undefined, undefined, entity);
          } catch {}

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

      const facts = await getFactsForEntity(entityId);
      let filtered = facts;
      if (question && question.trim()) {
        const questionLower = question.toLowerCase();
        const questionWords = questionLower.split(/\s+/).filter(w => w.length > 2);
        filtered = facts.filter(fact => {
          const factNameLower = fact.name.toLowerCase();
          return questionWords.some(word => factNameLower.includes(word)) ||
                 factNameLower.includes(questionLower) ||
                 questionLower.includes(factNameLower);
        });
        if (filtered.length === 0) {
          filtered = facts;
        }
      }

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
}

export const knowledgeQueryTool = new KnowledgeQueryTool();


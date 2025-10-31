import { DynamicTool } from '@langchain/core/tools';
import { resolveEntity } from '../services/entityResolver.js';
import { getFact, getFactsForEntity } from '../services/factsStore.js';

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
        hint: 'Pass JSON like {"entity": "Apple Inc", "variable_name": "ceo_name"} or just a plain entity name string.'
      });
    }

    try {
      // 1️⃣ Resolve entity ID
      const entityType = 'company'; // Default, could be enhanced to detect type
      const entityId = await resolveEntity(entity, entityType);

      // 2️⃣ If a specific variable is requested
      if (variable_name) {
        const fact = await getFact(entityId, variable_name);
        if (!fact) {
          return JSON.stringify({
            entity,
            entity_id: entityId,
            variable_name,
            error: 'No fact found'
          });
        }
        
        return JSON.stringify({
          entity,
          entity_id: entityId,
          variable_name: fact.name,
          value: fact.value,
          dtype: fact.dtype,
          confidence: fact.confidence,
          sources: fact.sources,
          observed_at: fact.observed_at.toISOString(),
          valid_from: fact.valid_from.toISOString()
        });
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


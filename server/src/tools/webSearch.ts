import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { fetchAndExtractText, tavilySearch, truncate, type SearchResult } from './shared/web';

type Result = SearchResult;

class WebSearchTool extends StructuredTool {
  name = 'web_search';
  description = 'Search the web. Input MUST be valid JSON: {"query": string, "num"?: 1-10, "includeContent"?: boolean, "days"?: number, "depth"?: "basic"|"advanced"}. Returns JSON: [{title, url, snippet, content?}]';
  schema = z.object({
    query: z.string().min(2, 'query must be at least 2 characters'),
    num: z.number().int().min(1).max(10).optional().default(3),
    includeContent: z.boolean().optional().default(true),
    days: z.number().int().min(1).max(365).optional(),
    depth: z.enum(['basic', 'advanced']).optional().default('advanced')
  }).strict();

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    const { query, num, includeContent, days, depth } = input;

    const results = await tavilySearch(query, num ?? 3, { days, depth });

    if (includeContent && results.length) {
      const k = Math.min(results.length, 8);
      const top = results.slice(0, k);

      const settled = await Promise.allSettled(top.map(r => fetchAndExtractText(r.url)));
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled' && s.value) {
          const content = truncate(s.value, 8000);
          top[i].content = content;
          if (!top[i].snippet || (top[i].snippet?.length ?? 0) < 120) {
            top[i].snippet = truncate(content, 600);
          }
        }
      });

      results.splice(0, k, ...top);
    }

    return JSON.stringify(results);
  }
}

export const webSearchTool = new WebSearchTool();

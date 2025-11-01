import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { fetchAndExtractText, tavilySearch, truncate, type SearchResult } from './shared/web';
import { summarizeForQuery } from './shared/summarize';

type Result = SearchResult;

class WebSearchTool extends StructuredTool {
  name = 'web_search';
  description = 'Search the web. Input MUST be valid JSON: {"query": string, "num"?: 1-10, "includeContent"?: boolean, "days"?: number, "depth"?: "basic"|"advanced"}. Returns JSON: [{title, url, snippet, summary?, key_facts?, quotes?, excerpt?, published_at?}]';
  schema = z.object({
    query: z.string().min(2, 'query must be at least 2 characters'),
    num: z.number().int().min(1).max(10).optional().default(3),
    includeContent: z.boolean().optional().default(false),
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
      const summarized = await Promise.allSettled(
        settled.map(async (s, i) => {
          if (s.status === 'fulfilled' && s.value) {
            const raw = s.value;
            const sum = await summarizeForQuery(raw, query);
            const excerpt = truncate(raw, 1000);
            const updated: SearchResult = {
              ...top[i],
              summary: sum.summary,
              key_facts: sum.key_facts,
              quotes: sum.quotes,
              excerpt,
              published_at: sum.published_at || top[i].published_at
            };
            if (!updated.snippet || (updated.snippet?.length ?? 0) < 120) {
              updated.snippet = truncate(sum.summary || excerpt, 300);
            }
            // Avoid attaching large content by default
            delete (updated as any).content;
            return updated;
          }
          return top[i];
        })
      );
      const merged: SearchResult[] = summarized.map(s => (s.status === 'fulfilled' ? s.value : top[0]));
      results.splice(0, k, ...merged);
    }

    return JSON.stringify(results);
  }
}

export const webSearchTool = new WebSearchTool();

import fetch from 'node-fetch';
import { DynamicTool } from '@langchain/core/tools';

type Result = { title?: string; url: string; snippet?: string };

async function tavilySearch(query: string, num: number): Promise<Result[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: num })
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data?.results ?? []).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet
  }));
}

export const webSearchTool = new DynamicTool({
  name: 'web_search',
  description: 'Search the web and return JSON results: [{title, url, snippet}]',
  func: async (input: string) => {
    let query = input;
    let num = 6;
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed?.query === 'string') query = parsed.query;
      if (typeof parsed?.num === 'number') num = parsed.num;
    } catch {
      // input is plain query string
    }

    const provider = process.env.SEARCH_PROVIDER || 'tavily';
    const results = await tavilySearch(query, num);

    return JSON.stringify(results);
  }
});

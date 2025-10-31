import fetch from 'node-fetch';

export interface SearchResultItem {
  title?: string;
  url: string;
  snippet?: string;
}

export interface SearchProvider {
  search: (q: string, opts?: { num?: number }) => Promise<SearchResultItem[]>;
}

export interface LlmProvider {
  complete: (prompt: string, opts?: { json?: boolean }) => Promise<string>;
}

export function createTavilySearch(): SearchProvider {
  const apiKey = process.env.TAVILY_API_KEY;
  return {
    async search(q: string, opts?: { num?: number }) {
      if (!apiKey) return [];
      const limit = opts?.num ?? 5;
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query: q, max_results: limit })
      });
      if (!res.ok) return [];
      const data: any = await res.json();
      const results: SearchResultItem[] = (data?.results ?? []).map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet
      }));
      return results;
    }
  };
}

export function createSerpApiSearch(): SearchProvider {
  const apiKey = process.env.SERPAPI_API_KEY;
  return {
    async search(q: string, opts?: { num?: number }) {
      if (!apiKey) return [];
      const num = opts?.num ?? 5;
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', q);
      url.searchParams.set('num', String(num));
      url.searchParams.set('api_key', apiKey);
      const res = await fetch(url);
      if (!res.ok) return [];
      const data: any = await res.json();
      const results: SearchResultItem[] = (data?.organic_results ?? []).map((r: any) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet
      }));
      return results;
    }
  };
}

export function createOpenAiLlm(): LlmProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return {
    async complete(prompt: string, opts?: { json?: boolean }) {
      if (!apiKey) {
        // Fallback mock for development without credentials
        return opts?.json ? JSON.stringify({ mock: true }) : 'Mock response (no OPENAI_API_KEY)';
      }
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a precise research assistant. Prefer structured, sourced answers.' },
            { role: 'user', content: prompt }
          ],
          response_format: opts?.json ? { type: 'json_object' } : undefined,
          temperature: 0.2
        })
      });
      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      return content;
    }
  };
}

export function getDefaultSearch(): SearchProvider {
  const preferred = process.env.SEARCH_PROVIDER || 'tavily';
  if (preferred === 'serpapi') return createSerpApiSearch();
  return createTavilySearch();
}

export function getDefaultLlm(): LlmProvider {
  return createOpenAiLlm();
}



import fetch from 'node-fetch';
import { ChatOpenAI } from '@langchain/openai';

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
  const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const model = new ChatOpenAI({
    model: modelName,
    temperature: 0.2,
    apiKey
  });

  return {
    async complete(prompt: string, opts?: { json?: boolean }) {
      if (!apiKey) {
        return opts?.json ? JSON.stringify({ mock: true }) : 'Mock response (no OPENAI_API_KEY)';
      }
      const aiMessage: any = await model.invoke(prompt);
      if (typeof aiMessage?.content === 'string') return aiMessage.content;
      if (Array.isArray(aiMessage?.content)) {
        return aiMessage.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
      }
      return '';
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



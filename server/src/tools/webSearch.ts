import fetch from 'node-fetch';
import { DynamicTool } from '@langchain/core/tools';

type Result = { title?: string; url: string; snippet?: string; content?: string };

function truncate(s: string, n: number) {
  if (!s) return s;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function fetchHtml(url: string, timeoutMs = 15000): Promise<string | undefined> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'artisan-bot/1.0 (+https://example.com)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow',
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) return;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return;
    return await res.text();
  } catch {
    return;
  }
}

function extractReadableText(html: string, url: string): string | undefined {
  try {
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || undefined;
  } catch {
    return;
  }
}

async function fetchAndExtract(url: string): Promise<string | undefined> {
  const html = await fetchHtml(url);
  if (!html) return;
  return extractReadableText(html, url);
}

async function tavilySearch(query: string, num: number, opts?: { days?: number; depth?: 'basic'|'advanced' }): Promise<Result[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  const body: any = { query, max_results: num };
  if (opts?.days != null) body.days = opts.days;
  if (opts?.depth) body.search_depth = opts.depth;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    return (data?.results ?? []).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet || r.content
    }));
  } catch {
    return [];
  }
}

export const webSearchTool = new DynamicTool({
  name: 'web_search',
  description: 'Search the web and return JSON results: [{title, url, snippet, content?}]',
  func: async (input: string) => {
    let query = input;
    let num = 10;
    let includeContent = true;
    let days: number | undefined;
    let depth: 'basic' | 'advanced' = 'advanced';

    try {
      const parsed = JSON.parse(input);
      if (typeof parsed?.query === 'string') query = parsed.query;
      if (typeof parsed?.num === 'number') num = parsed.num;
      if (typeof parsed?.includeContent === 'boolean') includeContent = parsed.includeContent;
      if (typeof parsed?.days === 'number') days = parsed.days;
      if (parsed?.depth === 'basic' || parsed?.depth === 'advanced') depth = parsed.depth;
    } catch {
      // input is plain query string
    }

    const results = await tavilySearch(query, num, { days, depth });

    if (includeContent && results.length) {
      const k = Math.min(results.length, 8);
      const top = results.slice(0, k);

      const settled = await Promise.allSettled(top.map(r => fetchAndExtract(r.url)));
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
});

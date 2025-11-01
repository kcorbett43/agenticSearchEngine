import fetch from 'node-fetch';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

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
}

export const webSearchTool = new WebSearchTool();

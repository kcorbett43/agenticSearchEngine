import fetch from 'node-fetch';

export type SearchResult = { title?: string; url: string; snippet?: string; content?: string };

export function truncate(s: string, n: number) {
  if (!s) return s;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export async function fetchHtml(url: string, timeoutMs = 15000): Promise<string | undefined> {
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

export function extractReadableText(html: string): string | undefined {
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

export async function fetchAndExtractText(url: string): Promise<string | undefined> {
  const html = await fetchHtml(url);
  if (!html) return;
  return extractReadableText(html);
}

export async function fetchHtmlAndText(url: string): Promise<{ html?: string; text?: string }> {
  const html = await fetchHtml(url);
  if (!html) return {};
  return { html, text: extractReadableText(html) };
}

export async function tavilySearch(
  query: string,
  num: number,
  opts?: { days?: number; depth?: 'basic' | 'advanced' }
): Promise<SearchResult[]> {
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



import fetch from 'node-fetch';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';

type SearchResult = { title?: string; url: string; snippet?: string; content?: string };
type LatestSource = SearchResult & { published_at?: string; credibility_score: number };

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

function extractReadableText(html: string): string | undefined {
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

async function fetchAndExtract(url: string): Promise<{ html?: string; text?: string }> {
  const html = await fetchHtml(url);
  if (!html) return {};
  return { html, text: extractReadableText(html) };
}

async function tavilySearch(query: string, num: number, opts?: { days?: number; depth?: 'basic'|'advanced' }): Promise<SearchResult[]> {
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

function getAuthorityScore(url: string): number {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('sec.gov')) return 100;
    if (host.endsWith('wikidata.org')) return 90;
    if (host.endsWith('wikipedia.org')) return 85;
    if (host.endsWith('.gov')) return 80;
    if (host.endsWith('.edu')) return 75;
    if (host.endsWith('bloomberg.com')) return 74;
    if (host.endsWith('reuters.com')) return 73;
    if (host.endsWith('ft.com') || host.endsWith('ftacademy.cn')) return 72;
    if (host.endsWith('nytimes.com') || host.endsWith('wsj.com')) return 71;
    if (host.startsWith('www.') && !host.endsWith('blogspot.com') && !host.endsWith('wordpress.com')) return 65;
    return 50;
  } catch {
    return 0;
  }
}

function parseDateLoose(s: string): Date | undefined {
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  // Common patterns like "Oct 31, 2025" or "31 Oct 2025"
  const m = s.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i)
        || s.match(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i)
        || s.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (m) {
    const d2 = new Date(m[0]);
    if (!isNaN(d2.getTime())) return d2;
  }
  return;
}

function extractPublishedAt(html: string): Date | undefined {
  // JSON-LD datePublished/dateModified
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/i) || html.match(/"dateModified"\s*:\s*"([^"]+)"/i);
  if (ld && ld[1]) {
    const d = parseDateLoose(ld[1]);
    if (d) return d;
  }

  // OpenGraph/article meta
  const meta = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i)
           || html.match(/<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["'][^>]*>/i)
           || html.match(/<time[^>]+datetime=["']([^"']+)["'][^>]*>/i);
  if (meta && meta[1]) {
    const d = parseDateLoose(meta[1]);
    if (d) return d;
  }

  // Fallback: scan text for a reasonable date string
  // Keep it conservative to avoid random dates in comments
  const textWindow = html.slice(0, 20000);
  return parseDateLoose(textWindow);
}

function daysSince(date: Date): number {
  const now = Date.now();
  const ms = now - date.getTime();
  return Math.max(1, Math.ceil(ms / (24 * 3600 * 1000)));
}

function withinHours(a?: Date, b?: Date, hours = 36): boolean {
  if (!a || !b) return false;
  const diff = Math.abs(a.getTime() - b.getTime());
  return diff <= hours * 3600 * 1000;
}

async function refineQueriesWithLlm(userQuery: string): Promise<string[]> {
  try {
    // Use a lightweight model without tools to avoid circular dependency
    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const model = new ChatOpenAI({
      model: modelName,
      temperature: 0.7,
      apiKey,
      maxRetries: 2,
      timeout: 30_000
    });
    
    // Inject current date context for time-related searches
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const currentDateReadable = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    const sys = new SystemMessage(
      `You rewrite web search queries to find the most recent occurrence of an event/news/fact. ` +
      `Current date: ${currentDateReadable} (${currentDate}). Use this to interpret relative time references. ` +
      `Return ONLY a compact JSON array of 2-3 queries. Include key entities, event/action verbs, and recency hints. No commentary.`
    );
    const human = new HumanMessage(
      `User query: ${userQuery}
Return JSON array like ["...", "..."].`
    );
    const resp = await model.invoke([sys, human]);
    const content = typeof resp.content === 'string' ? resp.content : String(resp.content);
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      const out = (Array.isArray(arr) ? arr : []).map((q: any) => String(q || '').trim()).filter(Boolean);
      if (out.length > 0) return out.slice(0, 3);
    }
  } catch {}
  // Fallback heuristics
  const base = userQuery.replace(/\b(latest|last|newest|most recent)\b/gi, '').trim();
  return [
    `${base} latest`,
    `${base} announcement date`,
    `${base} news`
  ];
}

// Generate description with current date
function getLatestFinderDescription(): string {
  const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const currentDateReadable = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  return `Find the most recent occurrence/date of an event and verify it across at least 2 credible, distinct sources. Iteratively searches with time filters until no newer result is found.

Current date: ${currentDateReadable} (${currentDate}). Use this to interpret relative time references like "latest", "most recent", "last", etc.

IMPORTANT: Input MUST be valid JSON with:
- "query": string (REQUIRED) - The search query describing what event/date to find

Example: {"query":"Tesla Model Y launch date"}
Do NOT call this tool without a "query" field.`;
}

class LatestFinderTool extends StructuredTool {
  name = 'latest_finder';
  description = getLatestFinderDescription();
  schema = z.object({
    query: z.string().min(1)
  }).strict();

  async _call(input: { query: string }): Promise<string> {
    // Internal constants - not configurable by LLM
    const maxLoops = 5;
    const minSources = 2;
    const includeContent = true;
    const depth: 'basic' | 'advanced' = 'advanced';
    const initialDays: number | undefined = 365;

    // Parse inputs - only accept query from LLM
    const query = input.query;
    if (!query || !query.trim()) {
      return JSON.stringify({ error: 'Query is required. Pass JSON: {"query":"..."}' });
    }

    if (!process.env.TAVILY_API_KEY) {
      return JSON.stringify({ error: 'Missing TAVILY_API_KEY' });
    }

    const refinedQueries = await refineQueriesWithLlm(query);
    const allSeen: Map<string, LatestSource> = new Map(); // by URL
    const byDomainDate: Map<string, Date> = new Map();
    let currentLatest: Date | undefined;
    let iterations = 0;

    while (iterations < maxLoops) {
      iterations += 1;
      const daysWindow = currentLatest ? Math.max(1, daysSince(currentLatest)) : (initialDays ?? 365);

      // Query breadth: try up to 3 refined variants
      const candidates: SearchResult[] = [];
      for (const rq of refinedQueries) {
        const res = await tavilySearch(rq, 6, { days: daysWindow, depth });
        for (const r of res) candidates.push(r);
      }

      // Fetch and date-extract for top K distinct URLs
      const seenThisRound = new Set<string>();
      const top = candidates.filter(r => {
        if (!r?.url || seenThisRound.has(r.url)) return false;
        seenThisRound.add(r.url);
        return true;
      }).slice(0, 10);

      const settled = await Promise.allSettled(top.map(async (r) => {
        const { html, text } = await fetchAndExtract(r.url);
        let published: Date | undefined;
        if (html) {
          published = extractPublishedAt(html) || (text ? extractPublishedAt(text) : undefined);
        }
        const cred = getAuthorityScore(r.url);
        const content = includeContent && text ? truncate(text, 8000) : undefined;

        const enriched: LatestSource = {
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          content,
          published_at: published ? published.toISOString() : undefined,
          credibility_score: cred
        };
        return enriched;
      }));

      let foundNewer = false;
      for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        const src = s.value;
        allSeen.set(src.url, src);

        const d = src.published_at ? new Date(src.published_at) : undefined;
        if (d && (!currentLatest || d > currentLatest)) {
          currentLatest = d;
          foundNewer = true;
        }
        // track domain latest date
        try {
          const domain = new URL(src.url).hostname.toLowerCase();
          if (d) {
            const prev = byDomainDate.get(domain);
            if (!prev || d > prev) byDomainDate.set(domain, d);
          }
        } catch {}
      }

      // If we didn't find anything newer, stop
      if (!foundNewer) break;

      // If latest found, ensure corroboration from distinct credible sources near that date
      const latestTarget = currentLatest;
      const corroborating: LatestSource[] = [];
      const domains = new Set<string>();
      for (const v of allSeen.values()) {
        const d = v.published_at ? new Date(v.published_at) : undefined;
        if (!latestTarget || !withinHours(d, latestTarget, 48)) continue;
        try {
          const domain = new URL(v.url).hostname.toLowerCase();
          if (domains.has(domain)) continue;
          if (v.credibility_score >= 65) {
            domains.add(domain);
            corroborating.push(v);
          }
        } catch {}
      }

      if (corroborating.length >= minSources) {
        // We have enough credible corroboration near the latest date; do one more pass to confirm no newer
        continue;
      }

      // Otherwise, refine queries heuristically for next loop
      const base = query.replace(/\b(latest|last|newest|most recent)\b/gi, '').trim();
      const plus = ['announced', 'released', 'launch', 'filed', 'acquired', 'date', 'news'];
      for (const p of plus) {
        const qv = `${base} ${p}`.trim();
        if (!refinedQueries.includes(qv)) refinedQueries.push(qv);
      }
      const authorityHints = ['site:wikipedia.org', 'site:reuters.com', 'site:sec.gov', 'site:company'];
      for (const h of authorityHints) {
        const qv = `${base} ${h}`.trim();
        if (!refinedQueries.includes(qv)) refinedQueries.push(qv);
      }
      // Cap list size
      while (refinedQueries.length > 6) refinedQueries.pop();
    }

    // Prepare final selection around the latest date with corroboration requirement
    const latest = currentLatest;
    const results: LatestSource[] = [];
    const usedDomains = new Set<string>();
    if (latest) {
      // prioritize by credibility and proximity to latest
      const sorted = Array.from(allSeen.values()).sort((a, b) => {
        const da = a.published_at ? Math.abs(new Date(a.published_at).getTime() - latest.getTime()) : 1e18;
        const db = b.published_at ? Math.abs(new Date(b.published_at).getTime() - latest.getTime()) : 1e18;
        if (a.credibility_score !== b.credibility_score) return b.credibility_score - a.credibility_score;
        return da - db;
      });

      for (const s of sorted) {
        const d = s.published_at ? new Date(s.published_at) : undefined;
        if (!d || !withinHours(d, latest, 72)) continue;
        try {
          const domain = new URL(s.url).hostname.toLowerCase();
          if (usedDomains.has(domain)) continue;
          usedDomains.add(domain);
          results.push(s);
          if (results.length >= 6) break;
        } catch {}
      }
    }

    const corroborationCount = new Set(results.map(r => {
      try { return new URL(r.url).hostname.toLowerCase(); } catch { return r.url; }
    })).size;

    return JSON.stringify({
      query,
      latest_date: latest ? latest.toISOString() : null,
      sources: results,
      corroboration: {
        distinct_sources: corroborationCount,
        min_required: minSources,
        credibility_threshold: 65,
        ok: corroborationCount >= minSources && !!latest
      },
      total_collected: allSeen.size,
      iterations
    });
  }
}

export const latestFinderTool = new LatestFinderTool();


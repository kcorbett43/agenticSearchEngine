import React, { useMemo, useState } from 'react';

type Source = { title?: string; url: string; snippet?: string };
type Variable = { name: string; type: string; value: unknown; confidence: number; sources: Source[] };

type Result = {
  intent: 'boolean' | 'specific' | 'contextual';
  variables: Variable[];
  notes?: string;
};

const API_URL = ''; // Empty string means same origin, proxy will handle it

export function App() {
  const [query, setQuery] = useState('Tell me about Stripe\'s business model');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const intentLabel = useMemo(() => {
    if (!result) return '';
    if (result.intent === 'boolean') return 'Boolean question';
    if (result.intent === 'specific') return 'Specific answer';
    return 'Contextual information';
  }, [result]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_URL}/api/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      if (!res.ok) throw new Error('Request failed');
      const json = (await res.json()) as Result;
      setResult(json);
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <h1>Artisan Research</h1>
      <p className="muted">Enter a natural language query about a company or person. The app will return structured, sourced magic variables.</p>
      <div className="card" style={{ marginTop: 12 }}>
        <form onSubmit={onSubmit} className="row">
          <input
            placeholder="e.g., Is OpenAI profitable? or Who founded Nvidia?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button disabled={loading}>{loading ? 'Researching…' : 'Research'}</button>
        </form>
      </div>

      {error && (
        <div className="card" style={{ marginTop: 12, borderColor: '#ef444466' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted">Detected intent: {intentLabel}</div>
          <div className="vars" style={{ marginTop: 12 }}>
            {result.variables.map((v, i) => (
              <div key={i} className="var">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{v.name}</strong>
                  <span className="muted">{v.type} · {(v.confidence * 100).toFixed(0)}% confident</span>
                </div>
                <div style={{ marginTop: 8 }}>
                  {renderValue(v)}
                </div>
                <div className="sources" style={{ marginTop: 8 }}>
                  {v.sources.slice(0, 5).map((s, j) => (
                    <div key={j}>
                      <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>
                      {s.snippet ? ` — ${s.snippet}` : ''}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {result.notes && (
            <div className="muted" style={{ marginTop: 12 }}>{result.notes}</div>
          )}
        </div>
      )}
    </div>
  );
}

function renderValue(v: Variable) {
  if (v.type === 'boolean') return <span>{String(v.value)}</span>;
  if (v.type === 'url') return (
    <a href={String(v.value)} target="_blank" rel="noreferrer">{String(v.value)}</a>
  );
  if (v.type === 'number') return <span>{String(v.value)}</span>;
  if (v.type === 'date') {
    const d = new Date(String(v.value));
    return <span>{isNaN(d.getTime()) ? String(v.value) : d.toDateString()}</span>;
  }
  if (typeof v.value === 'object') return <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(v.value, null, 2)}</pre>;
  return <span>{String(v.value)}</span>;
}



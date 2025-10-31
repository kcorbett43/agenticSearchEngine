import React, { useEffect, useMemo, useRef, useState } from 'react';

type Source = { title?: string; url: string; snippet?: string };
type Variable = { name: string; type: string; value: unknown; confidence: number; sources: Source[] };

type Result = {
  intent: 'boolean' | 'specific' | 'contextual';
  variables: Variable[];
  notes?: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  status?: 'pending' | 'done' | 'error';
};

const API_URL = 'http://localhost:4001';

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sessionId = useMemo(() => {
    let id = localStorage.getItem('artisan_session_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('artisan_session_id', id);
    }
    return id;
  }, []);

  useEffect(() => {
    // initial message to hint usage
    if (messages.length === 0) {
      setMessages([
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Ask me about companies or people. I will research and extract structured facts with sources.',
          createdAt: Date.now(),
          status: 'done'
        }
      ]);
    }
  }, []);

  useEffect(() => {
    // auto scroll to bottom on new message
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    setError(null);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
      status: 'done'
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    setSending(true);
    try {
      const res = await fetch(`${API_URL}/api/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, sessionId })
      });
      if (!res.ok) throw new Error('Request failed');
      const json = (await res.json()) as Result;
      const text = renderAssistantText(json);
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: text,
        createdAt: Date.now(),
        status: 'done'
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again.',
        createdAt: Date.now(),
        status: 'error'
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void handleSend();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h1>Artisan Chat</h1>
        <div className="muted">Multi-turn Q&A with structured research responses</div>
      </div>

      <div className="chat-messages" ref={listRef} aria-live="polite" aria-relevant="additions">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
      </div>

      <form className="chat-input-bar" onSubmit={onSubmit}>
        <textarea
          placeholder={sending ? 'Working…' : 'Type your message'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={sending}
          aria-label="Chat input"
        />
        <button type="submit" disabled={sending || input.trim().length === 0} aria-label="Send message">
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>

      {error && (
        <div className="chat-error" role="alert">{error}</div>
      )}
    </div>
  );
}

function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const ts = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  // Convert URLs in content to clickable links
  const formatContent = (text: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    return parts.map((part, i) => {
      if (urlRegex.test(part)) {
        return <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>;
      }
      return <span key={i}>{part}</span>;
    });
  };
  
  return (
    <div className={isUser ? 'msg-row user' : 'msg-row assistant'}>
      <div className="bubble">
        <div className="content">{formatContent(message.content)}</div>
        <div className="footer">
          <span className="muted">{ts}{message.status === 'error' ? ' · error' : ''}</span>
        </div>
      </div>
    </div>
  );
}

function renderAssistantText(result: Result): string {
  const lines: string[] = [];
  const vars = Array.isArray(result.variables) ? result.variables.slice(0, 5) : [];

  const boolVar = vars.find(v => typeof v.value === 'boolean');
  if (result.intent === 'boolean' && boolVar) {
    const label = boolVar.name.replace(/_/g, ' ');
    lines.push(`${label.charAt(0).toUpperCase() + label.slice(1)}: ${boolVar.value ? 'Yes.' : 'No.'}`);
    const src = boolVar.sources?.[0];
    if (src?.url) lines.push(`Source: ${src.title ?? ''} ${src.url}`.trim());

    const extras = vars.filter(v => v !== boolVar);
    for (const v of extras) {
      const label = v.name.replace(/_/g, ' ');
      const valueStr = typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value);
      lines.push(`${label.charAt(0).toUpperCase() + label.slice(1)}: ${valueStr}`);
      const s = v.sources?.[0];
      if (s?.url) lines.push(`  Source: ${s.title ?? ''} ${s.url}`.trim());
    }
    return lines.join('\n');
  }

  if (result.intent === 'specific' && vars.length) {
    for (const v of vars) {
      const label = v.name.replace(/_/g, ' ');
      const valueStr = typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value);
      lines.push(`${label.charAt(0).toUpperCase() + label.slice(1)}: ${valueStr}`);
      const src = v.sources?.[0];
      if (src?.url) lines.push(`  Source: ${src.title ?? ''} ${src.url}`.trim());
    }
    return lines.join('\n');
  }

  const contextVar = vars.find(
    (v): v is Variable & { value: string } =>
      v.name === 'context' && typeof v.value === 'string'
  );  
  
  if (contextVar && contextVar.value.trim()) {
    lines.push(String(contextVar.value));
    const src = contextVar.sources?.[0];
    if (src?.url) lines.push(`Source: ${src.title ?? ''} ${src.url}`.trim());
    return lines.join('\n');
  }

  for (const v of vars) {
    const label = v.name.replace(/_/g, ' ');
    const valueStr = typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value);
    lines.push(`${label.charAt(0).toUpperCase() + label.slice(1)}: ${valueStr}`);
  }
  if (!lines.length && result.notes) lines.push(result.notes);
  return lines.join('\n');
}



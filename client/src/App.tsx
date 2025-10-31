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
        body: JSON.stringify({ query: trimmed })
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
  return (
    <div className={isUser ? 'msg-row user' : 'msg-row assistant'}>
      <div className="bubble">
        <div className="content">{message.content}</div>
        <div className="footer">
          <span className="muted">{ts}{message.status === 'error' ? ' · error' : ''}</span>
        </div>
      </div>
    </div>
  );
}

function renderAssistantText(result: Result): string {
  const parts: string[] = [];
  const title =
    result.intent === 'boolean' ? 'Boolean question' : result.intent === 'specific' ? 'Specific answer' : 'Contextual information';
  parts.push(`Detected intent: ${title}`);
  if (Array.isArray(result.variables) && result.variables.length > 0) {
    for (const v of result.variables.slice(0, 5)) {
      const valueStr = typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value);
      parts.push(`• ${v.name} (${v.type}, ${(v.confidence * 100).toFixed(0)}%): ${valueStr}`);
      const src = v.sources?.[0];
      if (src?.url) parts.push(`  ↳ source: ${src.title ?? ''} ${src.url}`.trim());
    }
  }
  if (result.notes) parts.push(`Notes: ${result.notes}`);
  return parts.join('\n');
}



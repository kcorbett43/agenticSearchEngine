import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';

const histories = new Map<string, InMemoryChatMessageHistory>();
const MAX_MESSAGES = Number(process.env.CHAT_MEMORY_WINDOW || 8);

export function getHistory(sessionId: string): InMemoryChatMessageHistory {
  let history = histories.get(sessionId);
  if (!history) {
    history = new InMemoryChatMessageHistory();
    histories.set(sessionId, history);
  }
  return history;
}

export async function trimHistory(sessionId: string): Promise<void> {
  const history = histories.get(sessionId);
  if (!history) return;
  const messages = await history.getMessages();
  if (messages.length <= MAX_MESSAGES) return;
  let keep = messages.slice(-MAX_MESSAGES);

  const first: any = keep[0];
  const toolCallId: string | undefined = (first && (first as any).tool_call_id) ? String((first as any).tool_call_id) : undefined;
  if (toolCallId) {
    const startIdx = messages.length - MAX_MESSAGES - 1;
    for (let i = startIdx; i >= 0; i--) {
      const m: any = messages[i];
      const aiCalls: any[] | undefined = Array.isArray(m?.tool_calls) ? m.tool_calls : undefined;
      if (aiCalls && aiCalls.some((c: any) => String(c?.id ?? '') === toolCallId)) {
        keep = [m, ...keep];
        break;
      }
    }
  }
  await history.clear();
  for (const m of keep) {
    await history.addMessage(m);
  }
}



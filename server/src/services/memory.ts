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
  const keep = messages.slice(-MAX_MESSAGES);
  await history.clear();
  for (const m of keep) {
    await history.addMessage(m);
  }
}



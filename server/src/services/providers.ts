import { ChatOpenAI } from '@langchain/openai';
import type { Tool } from '@langchain/core/tools';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseMessage } from '@langchain/core/messages';
import { webSearchTool } from '../tools/webSearch.js';
import { plausibilityCheckTool } from '../tools/plausibilityCheck.js';
import { apifySearchTool } from '../tools/apifySearch.js';
import { knowledgeQueryTool } from '../tools/knowledgeQuery.js';

export type LlmProvider = Runnable<BaseMessage[], BaseMessage>;

export function getDefaultLlm(): LlmProvider {
  const tools = [webSearchTool, plausibilityCheckTool, apifySearchTool, knowledgeQueryTool];
  return createOpenAiToolModel(tools);
}

export function createOpenAiToolModel(tools: Tool[]): LlmProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const model = new ChatOpenAI({
    model: modelName,
    temperature:1,
    apiKey,
    maxRetries: 2,
    timeout: 60_000
  });
  return model.bindTools(tools);
}


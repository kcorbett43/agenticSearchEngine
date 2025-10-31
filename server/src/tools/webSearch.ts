import { DynamicTool } from '@langchain/core/tools';
import { getDefaultSearch } from '../services/providers.js';

export const webSearchTool = new DynamicTool({
  name: 'web_search',
  description: 'Search the web and return JSON results: [{title, url, snippet}]',
  func: async (query: string) => {
    const search = getDefaultSearch();
    const results = await search.search(query, { num: 6 });
    return JSON.stringify(results);
  }
});



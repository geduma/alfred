import axios from 'axios';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { getLogger } from '../utils/logger';

export class WebSearchTool implements ToolHandler {
  private timeout: number;
  private resultsLimit: number;

  tool: Tool = {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  };

  constructor(config?: { timeout_seconds?: number; results_limit?: number }) {
    this.timeout = (config?.timeout_seconds || 10) * 1000;
    this.resultsLimit = config?.results_limit || 5;
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const query = params.query as string;
    const limit = (params.limit as number) || this.resultsLimit;

    if (!query) {
      return { success: false, output: '', error: 'Query is required' };
    }

    try {
      const results = await this.searchDuckDuckGo(query, limit);

      if (results.length === 0) {
        return { success: true, output: 'No results found.' };
      }

      const output = results.map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`
      ).join('\n\n');

      return {
        success: true,
        output: `Resultados de búsqueda para "${query}":\n\n${output}`,
      };
    } catch (error: any) {
      getLogger().error({ error: error.message, query }, 'Web search failed');
      return { success: false, output: '', error: `Search failed: ${error.message}` };
    }
  }

  private async searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const response = await axios.get(url, {
      timeout: this.timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Alfred/2.0)',
      },
    });

    const results: SearchResult[] = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links: Array<{ url: string; title: string }> = [];
    let match;

    while ((match = linkRegex.exec(response.data)) !== null && links.length < limit) {
      links.push({
        url: match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, '').replace(/&rut=.*$/, ''),
        title: match[2].replace(/<[^>]*>/g, '').trim(),
      });
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(response.data)) !== null && snippets.length < limit) {
      snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
    }

    for (let i = 0; i < Math.min(links.length, limit); i++) {
      results.push({
        title: links[i].title,
        url: decodeURIComponent(links[i].url),
        snippet: snippets[i] || '',
      });
    }

    return results;
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

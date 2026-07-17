import axios from 'axios';
import * as cheerio from 'cheerio';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { getLogger } from '../utils/logger';

export class WebTool implements ToolHandler {
  private timeout: number;
  private maxSize: number;
  private resultsLimit: number;

  tool: Tool = {
    name: 'web',
    description: 'Search the web or fetch content from a URL. Use action "search" for queries or "fetch" for specific URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'fetch'] },
        query: { type: 'string', description: 'Search query (required for search action)' },
        url: { type: 'string', description: 'URL to fetch (required for fetch action)' },
        limit: { type: 'number', description: 'Max results for search (default: 5)' },
      },
      required: ['action'],
    },
  };

  constructor(config?: { timeout_seconds?: number; max_size_mb?: number; results_limit?: number }) {
    this.timeout = (config?.timeout_seconds || 15) * 1000;
    this.maxSize = (config?.max_size_mb || 10) * 1024 * 1024;
    this.resultsLimit = config?.results_limit || 5;
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'search':
        return this.search(params);
      case 'fetch':
        return this.fetch(params);
      default:
        return { success: false, output: '', error: `Unknown action: ${action}. Use 'search' or 'fetch'.` };
    }
  }

  private async search(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const query = params.query as string;
    const limit = (params.limit as number) || this.resultsLimit;

    if (!query) {
      return { success: false, output: '', error: 'query is required for search action' };
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
        output: `Search results for "${query}":\n\n${output}`,
      };
    } catch (error: any) {
      getLogger().error({ error: error.message, query }, 'Web search failed');
      return { success: false, output: '', error: `Search failed: ${error.message}` };
    }
  }

  private async fetch(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const url = params.url as string;

    if (!url) {
      return { success: false, output: '', error: 'url is required for fetch action' };
    }

    try {
      const response = await axios.get(url, {
        timeout: this.timeout,
        maxContentLength: this.maxSize,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Alfred/2.0)',
        },
      });

      const $ = cheerio.load(response.data);
      $('script, style, nav, footer, header, iframe, noscript').remove();

      const title = $('title').text().trim();
      const bodyContent = $('body').text()
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 5000);

      const output = [
        `Title: ${title}`,
        `URL: ${url}`,
        `---`,
        bodyContent,
      ].join('\n');

      return { success: true, output };
    } catch (error: any) {
      getLogger().error({ error: error.message, url }, 'Web fetch failed');
      return { success: false, output: '', error: `Fetch failed: ${error.message}` };
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

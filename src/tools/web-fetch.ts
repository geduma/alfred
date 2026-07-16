import axios from 'axios';
import * as cheerio from 'cheerio';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { getLogger } from '../utils/logger';

export class WebFetchTool implements ToolHandler {
  private timeout: number;
  private maxSize: number;

  tool: Tool = {
    name: 'web_fetch',
    description: 'Fetch and parse content from a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  };

  constructor(config?: { timeout_seconds?: number; max_size_mb?: number }) {
    this.timeout = (config?.timeout_seconds || 15) * 1000;
    this.maxSize = (config?.max_size_mb || 10) * 1024 * 1024;
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const url = params.url as string;

    if (!url) {
      return { success: false, output: '', error: 'URL is required' };
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
}

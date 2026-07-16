import fs from 'fs';
import path from 'path';
import { SoulLoader } from './soul-loader';

const DEFAULT_BASE_PROMPT_PATH = path.resolve(__dirname, '../../config/system-prompt-base.txt');

export class PromptBuilder {
  private soulLoader: SoulLoader;
  private soulMd: string = '';

  constructor() {
    this.soulLoader = new SoulLoader();
  }

  async loadSoul(personalityFile: string): Promise<void> {
    this.soulMd = await this.soulLoader.load(personalityFile);
  }

  async buildSystemPrompt(skillsContext?: string): Promise<string> {
    const basePrompt = this.loadBasePrompt();

    let systemPrompt = `${this.soulMd}\n\n---\n\n${basePrompt}`;

    if (skillsContext) {
      systemPrompt += `\n\n## Available Skills\n${skillsContext}`;
    }

    return systemPrompt;
  }

  private loadBasePrompt(): string {
    const promptPath = process.env.BASE_PROMPT_PATH || DEFAULT_BASE_PROMPT_PATH;
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8');
    }
    return 'You are Alfred, a helpful AI assistant. Respond in Spanish.';
  }
}

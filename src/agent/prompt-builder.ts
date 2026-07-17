import fs from 'fs';
import path from 'path';
import { SoulLoader } from './soul-loader';
import { WORKSPACE_PATHS } from '../utils/workspace';

const DEFAULT_BASE_PROMPT_PATH = path.resolve(__dirname, '../../system/system-prompt-base.txt');
const RULES_PATH = path.resolve(__dirname, '../../system/alfred-rules.md');
const PREFERENCES_PATH = WORKSPACE_PATHS.preferences();

export class PromptBuilder {
  private soulLoader: SoulLoader;
  private soulMd: string = '';

  constructor() {
    this.soulLoader = new SoulLoader();
  }

  async loadSoul(personalityFile: string): Promise<void> {
    this.soulMd = await this.soulLoader.load(personalityFile);
  }

  async reload(personalityFile?: string): Promise<void> {
    if (personalityFile) {
      this.soulMd = await this.soulLoader.load(personalityFile);
    }
  }

  async buildSystemPrompt(skillsContext?: string): Promise<string> {
    const basePrompt = this.loadBasePrompt();
    const rules = this.loadRules();
    const preferences = this.loadPreferences();
    const userName = this.getUserName(preferences);

    let systemPrompt = `${this.soulMd}\n\n---\n\n${basePrompt}`;

    if (userName && userName !== 'unknown') {
      systemPrompt = `## User Identity\nYour user's name is "${userName}". Always address them as "Señor ${userName}".\n\n---\n\n${systemPrompt}`;
    } else {
      systemPrompt = `## User Identity\nYou do not know the user's name yet. Ask for it on the very first message of every new session. When they tell you, save it immediately to preferences.md using the file_ops tool by updating the user_name field.\n\n---\n\n${systemPrompt}`;
    }

    if (preferences) {
      systemPrompt += `\n\n---\n\n${preferences}`;
    }

    if (rules) {
      systemPrompt += `\n\n---\n\n${rules}`;
    }

    if (skillsContext) {
      systemPrompt += `\n\n## Available Skills\n${skillsContext}`;
    }

    return systemPrompt;
  }

  private getUserName(preferencesRaw: string): string | null {
    if (!preferencesRaw) return null;
    for (const line of preferencesRaw.split('\n')) {
      const match = line.match(/^user_name:\s*(.+)$/i);
      if (match) return match[1].trim();
    }
    return null;
  }

  private loadBasePrompt(): string {
    const promptPath = process.env.BASE_PROMPT_PATH || DEFAULT_BASE_PROMPT_PATH;
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8');
    }
    return 'You are Alfred, a helpful AI assistant.';
  }

  private loadRules(): string {
    if (fs.existsSync(RULES_PATH)) {
      return fs.readFileSync(RULES_PATH, 'utf-8');
    }
    return '';
  }

  private loadPreferences(): string {
    if (fs.existsSync(PREFERENCES_PATH)) {
      return fs.readFileSync(PREFERENCES_PATH, 'utf-8');
    }
    return '';
  }
}

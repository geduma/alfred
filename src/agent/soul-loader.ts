import fs from 'fs';

export class SoulLoader {
  async load(filePath: string): Promise<string> {
    try {
      await fs.promises.access(filePath);
    } catch {
      throw new Error(`SOUL.md not found at ${filePath}`);
    }
    return fs.promises.readFile(filePath, 'utf-8');
  }
}
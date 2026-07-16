import fs from 'fs';

export class SoulLoader {
  async load(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`SOUL.md not found at ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }
}

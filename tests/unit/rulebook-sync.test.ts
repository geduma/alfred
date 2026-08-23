import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const REPO_RULEBOOK = path.join(REPO_ROOT, 'system', 'alfred-rules.md');
const BAKED_RULEBOOK_PATH = '/app/system/alfred-rules.md';
const DEFAULT_CONTAINER = 'alfred-agent';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function readFromRunningContainer(): Buffer | null {
  const container = process.env.ALFRED_CONTAINER_NAME || DEFAULT_CONTAINER;
  try {
    return execFileSync('docker', ['exec', container, 'cat', BAKED_RULEBOOK_PATH], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function readFromImage(): Buffer | null {
  const candidates: string[] = [];
  if (process.env.ALFRED_IMAGE_REF) candidates.push(process.env.ALFRED_IMAGE_REF);
  try {
    const composeImages = execFileSync(
      'docker',
      ['compose', '-f', path.join(REPO_ROOT, 'docker', 'docker-compose.yml'), 'config', '--images'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 },
    ).toString().trim();
    for (const line of composeImages.split('\n')) if (line.trim()) candidates.push(line.trim());
  } catch {
    // compose not usable; fall through to hardcoded default
  }
  if (candidates.length === 0) candidates.push('alfred-alfred');

  for (const image of candidates) {
    try {
      return execFileSync('docker', ['run', '--rm', '--entrypoint', 'cat', image, BAKED_RULEBOOK_PATH], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      continue;
    }
  }
  return null;
}

function readBakedRulebook(): { content: Buffer | null; source: string } {
  const fromContainer = readFromRunningContainer();
  if (fromContainer !== null) return { content: fromContainer, source: `container ${process.env.ALFRED_CONTAINER_NAME || DEFAULT_CONTAINER}` };
  const fromImage = readFromImage();
  if (fromImage !== null) return { content: fromImage, source: process.env.ALFRED_IMAGE_REF || 'compose image' };
  return { content: null, source: 'none' };
}

const dockerUp = dockerAvailable();

(dockerUp ? describe : describe.skip)('rulebook sync smoke test (docker)', () => {
  test('rulebook baked into the Docker image matches the repo copy byte-for-byte', () => {
    const repoContent = fs.readFileSync(REPO_RULEBOOK);
    const { content, source } = readBakedRulebook();

    if (content === null) {
      throw new Error(
        'Docker is available but no Alfred image/container was found to read ' +
        `${BAKED_RULEBOOK_PATH} from. Run ./deploy.sh first (or set ALFRED_IMAGE_REF / ALFRED_CONTAINER_NAME).`
      );
    }

    expect(source).toBeTruthy();
    expect(content.equals(repoContent)).toBe(true);
  });
});

if (!dockerUp) {
  describe('rulebook sync smoke test (docker absent)', () => {
    test('skipped because Docker CLI is unavailable on this machine', () => {
      console.warn('[rulebook-sync] Docker CLI not found — smoke test skipped. Run it on the deploy host after ./deploy.sh.');
      expect(fs.existsSync(REPO_RULEBOOK)).toBe(true);
    });
  });
}

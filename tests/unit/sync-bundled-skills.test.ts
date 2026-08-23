import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.resolve(__dirname, '../../scripts/sync-bundled-skills.sh');
const BUNDLE_SRC = path.resolve(__dirname, '../../system/skills-custom');

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-skills-'));
}

function runScript(workspace: string, env: Record<string, string> = {}): string {
  return execFileSync('bash', [SCRIPT], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      WORKSPACE_DIR: workspace,
      SRC_DIR: BUNDLE_SRC,
      ALFRED_UID: String(process.getuid?.() ?? 1000),
      DRY_RUN: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const BUNDLE_FILES = () => fs.readdirSync(BUNDLE_SRC).filter(f => f.endsWith('.md'));

describe('sync-bundled-skills.sh', () => {
  let workspace: string;
  let customDir: string;

  beforeEach(() => {
    workspace = makeWorkspace();
    customDir = path.join(workspace, 'skills', 'custom');
    fs.mkdirSync(customDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('adds missing bundled skills and writes the manifest', () => {
    const out = runScript(workspace);

    for (const name of BUNDLE_FILES()) {
      expect(fs.existsSync(path.join(customDir, name))).toBe(true);
    }
    const manifest = fs.readFileSync(path.join(workspace, 'skills', '.bundled-manifest'), 'utf-8')
      .split('\n').filter(Boolean).sort();
    expect(manifest.sort()).toEqual(BUNDLE_FILES().sort());
    expect(out).toContain('added');
  });

  test('overwrites outdated bundled skill and backs up the previous version', () => {
    const stale = BUNDLE_FILES()[0];
    fs.writeFileSync(path.join(customDir, stale), '# Stale content\n', 'utf-8');

    runScript(workspace);

    expect(fs.readFileSync(path.join(customDir, stale), 'utf-8'))
      .toBe(fs.readFileSync(path.join(BUNDLE_SRC, stale), 'utf-8'));

    const backupsRoot = path.join(workspace, 'skills', 'backups');
    const tsDirs = fs.readdirSync(backupsRoot);
    expect(tsDirs.length).toBe(1);
    expect(fs.readFileSync(path.join(backupsRoot, tsDirs[0], stale), 'utf-8')).toBe('# Stale content\n');
  });

  test('leaves identical bundled skills untouched (no backup created)', () => {
    const same = BUNDLE_FILES()[0];
    const other = BUNDLE_FILES()[1];
    fs.copyFileSync(path.join(BUNDLE_SRC, same), path.join(customDir, same));
    fs.writeFileSync(path.join(customDir, other), '# Outdated\n', 'utf-8');

    const before = fs.statSync(path.join(customDir, same)).mtimeMs;
    runScript(workspace);

    const afterPath = path.join(customDir, same);
    const stat = fs.statSync(afterPath);
    // Content identical; inode-level rewrite must not happen (cmp -s short-circuit).
    expect(stat.mtimeMs).toBe(before);
    expect(fs.readFileSync(afterPath, 'utf-8'))
      .toBe(fs.readFileSync(path.join(BUNDLE_SRC, same), 'utf-8'));
    expect(fs.readFileSync(path.join(customDir, other), 'utf-8'))
      .toBe(fs.readFileSync(path.join(BUNDLE_SRC, other), 'utf-8'));
  });

  test('never touches user-authored skills outside the bundle', () => {
    fs.writeFileSync(path.join(customDir, 'my-own-skill.md'), '# Mine\n', 'utf-8');

    runScript(workspace);

    expect(fs.readFileSync(path.join(customDir, 'my-own-skill.md'), 'utf-8')).toBe('# Mine\n');
    const manifest = fs.readFileSync(path.join(workspace, 'skills', '.bundled-manifest'), 'utf-8');
    expect(manifest).not.toContain('my-own-skill.md');
  });

  test('moves manifest-tracked orphans to backups/orphans instead of deleting', () => {
    const removed = 'retired-skill.md';
    const kept = BUNDLE_FILES()[0];
    fs.writeFileSync(path.join(workspace, 'skills', '.bundled-manifest'), `${removed}\n${kept}\n`, 'utf-8');
    fs.writeFileSync(path.join(customDir, removed), '# Old bundled skill no longer shipped\n', 'utf-8');

    runScript(workspace);

    expect(fs.existsSync(path.join(customDir, removed))).toBe(false);
    const backupsRoot = path.join(workspace, 'skills', 'backups');
    const tsDirs = fs.readdirSync(backupsRoot);
    const orphanPath = path.join(backupsRoot, tsDirs[0], 'orphans', removed);
    expect(fs.readFileSync(orphanPath, 'utf-8')).toBe('# Old bundled skill no longer shipped\n');
  });

  test('DRY_RUN=1 reports actions without modifying anything', () => {
    const stale = BUNDLE_FILES()[0];
    fs.writeFileSync(path.join(customDir, stale), '# Stale\n', 'utf-8');
    fs.writeFileSync(path.join(customDir, 'user-file.md'), '# User\n', 'utf-8');

    const out = runScript(workspace, { DRY_RUN: '1' });

    expect(out).toContain('[dry-run]');
    expect(fs.readFileSync(path.join(customDir, stale), 'utf-8')).toBe('# Stale\n');
    expect(fs.existsSync(path.join(workspace, 'skills', '.bundled-manifest'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'skills', 'backups'))).toBe(false);
  });
});

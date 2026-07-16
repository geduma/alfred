import { ConfigLoader } from '../../src/config/loader';
import * as fs from 'fs';
import * as path from 'path';

const TEST_CONFIG_PATH = path.resolve(__dirname, '../../workspace/config/alfred.json');

describe('ConfigLoader', () => {
  let loader: ConfigLoader;

  beforeAll(() => {
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      loader = new ConfigLoader(TEST_CONFIG_PATH);
    }
  });

  test('should load configuration without errors', () => {
    expect(loader).toBeDefined();
  });

  test('should have primary provider configured', () => {
    if (loader) {
      const chain = loader.providerChain;
      expect(chain.length).toBeGreaterThan(0);
    }
  });

  test('should have valid provider chain', () => {
    if (loader) {
      const providers = Object.keys(loader.providers);
      expect(providers).toContain(loader.llmConfig.primary_provider);
    }
  });

  test('should list enabled channels', () => {
    if (loader) {
      const channels = loader.enabledChannels;
      expect(Array.isArray(channels)).toBe(true);
    }
  });

  test('should list enabled tools', () => {
    if (loader) {
      const tools = loader.enabledTools;
      expect(Array.isArray(tools)).toBe(true);
    }
  });
});

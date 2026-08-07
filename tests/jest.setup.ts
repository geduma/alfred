import os from 'os';
import path from 'path';
import fs from 'fs';
import { initializeLogger } from '../src/utils/logger';

process.env.WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-workspace-test-'));

initializeLogger({ level: 'silent', format: 'json', targets: [], config: {} });

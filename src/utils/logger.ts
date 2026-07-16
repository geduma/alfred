import pino from 'pino';
import fs from 'fs';
import path from 'path';

let loggerInstance: pino.Logger;

export function initializeLogger(config: {
  level: string;
  format: string;
  targets: string[];
  config: {
    file_path?: string;
    max_size_mb?: number;
    retention_days?: number;
    rotate?: boolean;
  };
}): pino.Logger {
  if (loggerInstance) return loggerInstance;

  const targets: pino.TransportTargetOptions[] = [];

  if (config.targets.includes('console')) {
    targets.push({
      target: 'pino/file',
      options: {},
      level: config.level,
    });
  }

  if (config.targets.includes('file') && config.config.file_path) {
    const logDir = config.config.file_path;
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    targets.push({
      target: 'pino/file',
      options: {
        destination: path.join(logDir, 'alfred.log'),
        mkdir: true,
      },
      level: config.level,
    });
  }

  loggerInstance = pino({
    level: config.level,
    transport: {
      targets,
    },
  });

  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    loggerInstance = pino({ level: 'info' });
  }
  return loggerInstance;
}

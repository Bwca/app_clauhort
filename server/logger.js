/**
 * @fileoverview Structured logging. Every log line goes to a rotating file
 * as JSON (the durable, greppable record — this is what you'd actually
 * want available after the fact, e.g. while diagnosing a platform-specific
 * issue nobody was watching the terminal for) and, filtered to a coarser
 * level, as pretty/colorized output to the console (keeps the normal
 * `node index.js`/`npm run dev` experience unchanged).
 *
 * Other modules should call `logger.child({ component: '<name>' })` once
 * at their own top level and use that child logger for every call site,
 * rather than repeating a component field by hand — see agentProcessManager.js
 * for the pattern.
 */

import pino from 'pino';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOG_DIR = process.env.APP_LOG_DIR || join(__dirname, 'logs');
// Minimum level actually written to the file. The console below is
// deliberately NOT tied to this — it always stays at info+ regardless, so
// raising file verbosity for a deep-dive never floods the terminal.
const FILE_LEVEL = process.env.APP_LOG_LEVEL || 'info';

mkdirSync(LOG_DIR, { recursive: true });

export const logger = pino(
  {
    level: FILE_LEVEL === 'silent' ? 'silent' : 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  FILE_LEVEL === 'silent'
    ? undefined
    : pino.transport({
        targets: [
          {
            target: 'pino-roll',
            level: FILE_LEVEL,
            options: {
              file: join(LOG_DIR, 'app.log'),
              frequency: 'daily',
              size: '10m',
              mkdir: true,
              limit: { count: 14 },
            },
          },
          {
            target: 'pino-pretty',
            level: 'info',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        ],
      })
);

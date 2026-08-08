/**
 * @fileoverview E2E test runner.
 * Runs all test files in e2e/ sequentially using node:test.
 *
 * Usage:
 *   cd tests && npm test
 *   cd tests && npm test -- --grep "agent"   (filter by name substring)
 */

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// fileURLToPath, not raw `.pathname` — on Windows a file:// URL's pathname is
// "/C:/Users/..." (a leading slash before the drive letter), which isn't a
// valid native path; fileURLToPath correctly strips that.
const E2E_DIR = fileURLToPath(new URL('./e2e', import.meta.url));

const grep = process.argv.find((a) => a.startsWith('--grep='))?.slice(7)
  ?? (process.argv.includes('--grep') ? process.argv[process.argv.indexOf('--grep') + 1] : undefined);

const files = readdirSync(E2E_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join(E2E_DIR, f));

console.log(`Running ${files.length} test file(s)${grep ? ` matching "${grep}"` : ''}...\n`);

const stream = run({
  files,
  concurrency: 1,        // sequential — each file starts/stops its own server
  timeout: 120_000,
  ...(grep ? { testNamePatterns: [grep] } : {}),
});

stream
  .compose(spec())
  .pipe(process.stdout);

stream.on('test:fail', () => {
  process.exitCode = 1;
});

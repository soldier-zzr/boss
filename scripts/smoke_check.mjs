import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const mustFiles = ['manifest.json', 'content.js', 'popup.js', 'background.js', 'config/benchmark_repos.json'];
for (const f of mustFiles) {
  const p = path.join(root, f);
  await fs.access(p);
}

execSync('node --check content.js', { stdio: 'pipe' });
execSync('node --check popup.js', { stdio: 'pipe' });
execSync('node --check background.js', { stdio: 'pipe' });

const content = await fs.readFile(path.join(root, 'content.js'), 'utf8');
const popup = await fs.readFile(path.join(root, 'popup.js'), 'utf8');
const manifest = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');

const checks = [
  ['single instance lock', content.includes('__bossAutoGreetInitialized')],
  ['structured log', content.includes('session_id')],
  ['safe mode toggle', popup.includes('btn-mode')],
  ['dev benchmark script exists', mustFiles.includes('config/benchmark_repos.json')],
  ['background service worker', manifest.includes('service_worker')],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('SMOKE FAILED:', failed.map(x => x[0]).join(', '));
  process.exit(1);
}

console.log('SMOKE OK');

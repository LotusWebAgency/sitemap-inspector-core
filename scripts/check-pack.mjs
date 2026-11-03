import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'sitemap-core-pack-'));
const npmCache = join(work, 'npm-cache');
const failures = [];
const fail = (message) => { failures.push(message); };
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const ALLOWED = [/^dist\//, /^LICENSE$/, /^README\.md$/, /^CHANGELOG\.md$/, /^package\.json$/];
const REQUIRED = ['dist/index.js', 'dist/index.d.ts', 'dist/validator.js', 'LICENSE', 'README.md', 'CHANGELOG.md', 'package.json'];
const FORBIDDEN = [
  ['gitlab.com/lotusweb', /gitlab\.com\/lotusweb/],
  ['browser extension API use', /\b(chrome|browser)\.(runtime|tabs|storage|scripting|permissions|offscreen)\b/],
  ['#imports', /#imports/],
  ['.env', /\.env/],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path); else yield path;
  }
}

try {
  const packDir = join(work, 'pack');
  mkdirSync(packDir);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--cache', npmCache, '--pack-destination', packDir], root));
  const pack = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]; // newer npm keys the result by package name
  const names = pack.files.map((f) => f.path);
  for (const name of names) if (!ALLOWED.some((re) => re.test(name))) fail(`unexpected file in tarball: ${name}`);
  for (const name of REQUIRED) if (!names.includes(name)) fail(`missing from tarball: ${name}`);

  const tarball = join(packDir, pack.filename);
  const unpacked = join(work, 'unpacked');
  mkdirSync(unpacked);
  run('tar', ['-xzf', tarball, '-C', unpacked], root);
  for (const file of walk(unpacked)) {
    const text = readFileSync(file, 'utf8');
    for (const [label, re] of FORBIDDEN) {
      const m = re.exec(text);
      if (m) fail(`${label} found in ${file.slice(unpacked.length + 1)} near "${text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}"`);
    }
  }

  const consumer = join(work, 'pack-check');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'pack-check', private: true, type: 'module' }));
  run('npm', ['install', tarball, '--cache', npmCache, '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  const smoke = [
    "import { SitemapParser } from '@lotuswebagency/sitemap-core';",
    "import { ValidationRun } from '@lotuswebagency/sitemap-core/validator';",
    "if (typeof SitemapParser !== 'function' || typeof ValidationRun !== 'function') process.exit(1);",
  ].join('\n');
  run('node', ['--input-type=module', '-e', smoke], consumer);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`check:pack failed\n${failures.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}
process.stdout.write('check:pack ok\n');

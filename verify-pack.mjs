// Publish guard: prove the tarball contains exactly the runtime files and
// nothing from the verification harness. Runs as part of `npm run verify`, so a
// release cannot ship test scaffolding or a missing runtime module.
//
// Uses `npm pack --dry-run --json`, which reports the same file list the
// registry would receive without producing a tarball.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** Files a consumer must receive for the plugin to work. */
const REQUIRED = [
  'index.js',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'LICENSE',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
];

/** Paths that must never reach a consumer. */
const FORBIDDEN_PREFIXES = ['.git', '.github', 'node_modules', '.research'];
const FORBIDDEN_FILES = new Set([
  'test.mjs',
  'storm.mjs',
  'replay.mjs',
  'compare.mjs',
  'inject.json',
  '.gitignore',
  '.gitattributes',
  '.npmignore',
]);

function packList() {
  // `npm` is a .cmd shim on Windows, so it needs a shell there. Pass the whole
  // command as one string to avoid the DEP0190 args-with-shell warning.
  const isWindows = process.platform === 'win32';
  const raw = isWindows
    ? execFileSync('npm pack --dry-run --json', {
      cwd: new URL('.', import.meta.url),
      encoding: 'utf8',
      shell: true,
    })
    : execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: new URL('.', import.meta.url),
      encoding: 'utf8',
    });
  // npm may print lifecycle noise before the JSON payload; take the last JSON
  // document in the output.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error(`could not parse npm pack output:\n${raw}`);
  const [entry] = JSON.parse(raw.slice(start, end + 1));
  return entry.files.map((file) => file.path).sort();
}

const files = packList();
const problems = [];

for (const required of REQUIRED) {
  if (!files.includes(required)) problems.push(`missing required file: ${required}`);
}

for (const file of files) {
  if (FORBIDDEN_FILES.has(file)) problems.push(`forbidden file in tarball: ${file}`);
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (file === prefix || file.startsWith(`${prefix}/`)) {
      problems.push(`forbidden path in tarball: ${file}`);
    }
  }
}

console.log(`pack contents (${files.length} files):`);
for (const file of files) console.log(`  ${file}`);

if (problems.length > 0) {
  console.error(`\nFAIL  ${problems.length} packaging problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`\nPASS  ${pkg.name}@${pkg.version} packs ${files.length} files, all required and nothing forbidden`);

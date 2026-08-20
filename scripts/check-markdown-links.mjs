import { lstat, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectoryNames = new Set([
  '.git',
  '.primecontext',
  'coverage',
  'dist',
  'node_modules',
]);
const markdownFiles = [];
const failures = [];
let checkedLinks = 0;

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) await collect(absolute);
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      markdownFiles.push(absolute);
    }
  }
}

function localTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  if (target === '' || target.startsWith('#')) return undefined;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) return undefined;
  target = target.split('#', 1)[0].split('?', 1)[0];
  if (target === '') return undefined;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

await collect(root);

for (const markdownPath of markdownFiles) {
  const text = await import('node:fs/promises').then(({ readFile }) => readFile(markdownPath, 'utf8'));
  const linkPattern = /!?(?:\[[^\]]*\])\(([^)\s]+(?:\s+"[^"]*")?)\)/gu;
  for (const match of text.matchAll(linkPattern)) {
    const targetWithTitle = match[1];
    const rawTarget = targetWithTitle.replace(/\s+"[^"]*"$/u, '');
    const target = localTarget(rawTarget);
    if (target === undefined) continue;
    checkedLinks += 1;
    const resolved = resolve(dirname(markdownPath), target.replaceAll('/', sep));
    const rootPrefix = `${root}${sep}`;
    if (resolved !== root && !resolved.startsWith(rootPrefix)) {
      failures.push(`${relative(root, markdownPath)} -> ${target} (outside repository)`);
      continue;
    }
    try {
      const metadata = await lstat(resolved);
      if (metadata.isSymbolicLink()) {
        failures.push(`${relative(root, markdownPath)} -> ${target} (symbolic link)`);
      }
    } catch {
      failures.push(`${relative(root, markdownPath)} -> ${target} (missing)`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    markdown_file_count: markdownFiles.length,
    local_link_count: checkedLinks,
    missing_target_count: 0,
  })}\n`);
}

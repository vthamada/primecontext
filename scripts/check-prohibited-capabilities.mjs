import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = join(root, 'packages');
const forbiddenDependency = /(?:^|\/)(?:@modelcontextprotocol\/sdk|openai|@anthropic-ai\/sdk|axios|undici|node-fetch|ws|socket\.io-client|@sentry\/|posthog-node)(?:$|\/)/iu;
const forbiddenSource = [
  { label: 'network builtin import', pattern: /(?:from\s+|import\s*\()['"]node:(?:http|https|http2|net|tls|dgram|dns)[/'"]/u },
  { label: 'remote fetch', pattern: /\bfetch\s*\(/u },
  { label: 'WebSocket/EventSource', pattern: /\b(?:WebSocket|EventSource)\s*\(/u },
  { label: 'MCP or model SDK import', pattern: /(?:from\s+|import\s*\()['"](?:@modelcontextprotocol\/sdk|openai|@anthropic-ai\/sdk)(?:[/"'])/u },
];

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const violations = [];
const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const directory of packageDirectories) {
  const manifestPath = join(packagesRoot, directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (forbiddenDependency.test(name)) violations.push(`${relative(root, manifestPath)}: forbidden ${field} ${name}`);
    }
  }

  const sourceRoot = join(packagesRoot, directory, 'src');
  for (const path of await filesBelow(sourceRoot)) {
    if (extname(path) !== '.ts' || path.endsWith('.test.ts')) continue;
    const source = await readFile(path, 'utf8');
    for (const rule of forbiddenSource) {
      if (rule.pattern.test(source)) violations.push(`${relative(root, path)}: ${rule.label}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.sort().join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  production_package_count: packageDirectories.length,
  prohibited_runtime_capability_count: 0,
  note: 'Static regression gate; not a substitute for security review or runtime network denial.',
})}\n`);

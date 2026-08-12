import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { PrimeContextError } from '@primecontext/core';
import type * as TypeScript from 'typescript';
import { NodeFileSystemAdapter, assertNoSymbolicLinkComponents } from './filesystem.js';
import { assertPathInsideRoot, isSensitivePath } from './security.js';
import { isSensitiveDocumentContent } from './documents.js';
import {
  createCooperativeDeadlineV03,
  systemMonotonicNowV03,
  type MonotonicNowV03,
} from './cooperative-deadline.js';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_EXCERPT_CHARACTERS = 2_000;
const MAX_EXCERPT_LINES = 8;
const MAX_AST_DEPTH = 512;
const MAX_GRAPH_TEXT_CHARACTERS = 2_048;
const MAX_GRAPH_NAME_CHARACTERS = 512;
const MAX_TOTAL_EXCERPT_BYTES = 256 * 1024 * 1024;
const OPTIONAL_ADAPTER_DEADLINE_MS = 30_000;
const FILE_ID_PATTERN = /^CGF-[0-9a-f]{64}$/;
const NODE_ID_PATTERN = /^CGN-[0-9a-f]{64}$/;
const EDGE_ID_PATTERN = /^CGE-[0-9a-f]{64}$/;
const GRAPH_NODE_KINDS = new Set<CodeGraphNodeKindV03>([
  'file', 'function', 'class', 'interface', 'type', 'enum', 'variable', 'method', 'property',
]);
const GRAPH_EDGE_KINDS = new Set<CodeGraphEdgeKindV03>(['contains', 'imports', 'exports', 'calls']);

export interface CodeGraphLimitsV03 {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxNodes: number;
  maxEdges: number;
}

export const DEFAULT_CODEGRAPH_LIMITS_V03: Readonly<CodeGraphLimitsV03> = Object.freeze({
  maxFiles: 16_384,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxNodes: 100_000,
  maxEdges: 250_000,
});

export interface CodeGraphRuntimeV03 {
  loadTypeScript?: () => Promise<unknown>;
  monotonicNow?: MonotonicNowV03;
}

type TypeScriptModule = typeof TypeScript;

export type CodeGraphLanguageV03 = 'typescript' | 'javascript';
export type CodeGraphNodeKindV03 =
  | 'file'
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'method'
  | 'property';
export type CodeGraphEdgeKindV03 = 'contains' | 'imports' | 'exports' | 'calls';

export interface CodeGraphLocatorV03 {
  path: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface CodeGraphFileV03 {
  id: string;
  path: string;
  language: CodeGraphLanguageV03;
  source_hash: string;
  size_bytes: number;
}

export interface CodeGraphSnapshotV03 {
  repository_id: string;
  worktree_digest: string;
  head?: string;
}

export interface CodeGraphAcceptedSourceV03 {
  path: string;
  source_hash: string;
}

export interface CodeGraphCollectionBindingV03 {
  snapshot: CodeGraphSnapshotV03;
  accepted_sources: CodeGraphAcceptedSourceV03[];
}

export interface CodeGraphBindingV03 extends CodeGraphCollectionBindingV03 {
  accepted_source_digest: string;
}

export interface CodeGraphNodeV03 {
  id: string;
  kind: CodeGraphNodeKindV03;
  name: string;
  qualified_name: string;
  locator: CodeGraphLocatorV03;
  source_hash: string;
  exported: boolean;
  excerpt: string;
  excerpt_truncated: boolean;
}

export interface CodeGraphEdgeV03 {
  id: string;
  kind: CodeGraphEdgeKindV03;
  from_id: string;
  to_id?: string;
  target: string;
  locator: CodeGraphLocatorV03;
}

export interface LocalCodeGraphV03 {
  schema_version: '0.3';
  source_digest: string;
  graph_digest: string;
  binding: CodeGraphBindingV03;
  files: CodeGraphFileV03[];
  nodes: CodeGraphNodeV03[];
  edges: CodeGraphEdgeV03[];
  summary: {
    discovered_path_count: number;
    excluded_path_count: number;
    candidate_file_count: number;
    file_count: number;
    omitted_oversize_count: number;
    omitted_parse_error_count: number;
    omitted_sensitive_count: number;
    total_source_bytes: number;
    node_count: number;
    edge_count: number;
  };
}

interface ParsedCodeFile {
  file: CodeGraphFileV03;
  nodes: CodeGraphNodeV03[];
  localSymbols: Map<string, string>;
  exportedSymbols: Map<string, string>;
  importedBindings: Map<string, { imported: string; specifier: string }>;
  imports: PendingEdge[];
  calls: PendingCall[];
}

interface PendingEdge {
  kind: 'contains' | 'imports' | 'exports';
  fromId: string;
  target: string;
  locator: CodeGraphLocatorV03;
  toId?: string;
}

interface PendingCall {
  fromId: string;
  target: string;
  identifier?: string;
  lexicallyShadowed: boolean;
  locator: CodeGraphLocatorV03;
}

type StableCodeRead = { kind: 'content'; bytes: Uint8Array } | { kind: 'oversize' };

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function isSafeGraphPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024
    || posix.isAbsolute(value) || value.includes('\\') || value.includes(':')
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  const segments = value.split('/');
  return !segments.some((segment) => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment))
    && !isSensitivePath(value);
}

function assertValidCodeGraphSnapshot(value: unknown): asserts value is CodeGraphSnapshotV03 {
  if (typeof value !== 'object' || value === null) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph snapshot binding is invalid');
  }
  const snapshot = value as Partial<CodeGraphSnapshotV03>;
  if (typeof snapshot.repository_id !== 'string' || snapshot.repository_id.length === 0
    || snapshot.repository_id.length > 1_024 || /[\u0000-\u001f\u007f-\u009f]/u.test(snapshot.repository_id)
    || typeof snapshot.worktree_digest !== 'string' || !SHA256_PATTERN.test(snapshot.worktree_digest)
    || (snapshot.head !== undefined && (typeof snapshot.head !== 'string' || snapshot.head.length === 0
      || snapshot.head.length > 1_024 || /[\u0000-\u001f\u007f-\u009f]/u.test(snapshot.head)))) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph snapshot binding is invalid');
  }
}

function normalizeAcceptedSources(
  sources: readonly CodeGraphAcceptedSourceV03[],
): CodeGraphAcceptedSourceV03[] {
  if (!Array.isArray(sources) || sources.length > DEFAULT_CODEGRAPH_LIMITS_V03.maxFiles) {
    throw new PrimeContextError('CAPABILITY_ERROR', 'Local CodeGraph accepted-source manifest limit exceeded');
  }
  const byPath = new Map<string, string>();
  for (const source of sources) {
    if (typeof source !== 'object' || source === null || !isSafeGraphPath(source.path)
      || !SHA256_PATTERN.test(source.source_hash) || byPath.has(source.path)) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph accepted-source manifest is invalid');
    }
    byPath.set(source.path, source.source_hash);
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => ordinalCompare(left, right))
    .map(([path, source_hash]) => ({ path, source_hash }));
}

function resolveGraphBinding(
  root: string,
  sourceDigest: string,
  files: readonly CodeGraphFileV03[],
  supplied?: CodeGraphCollectionBindingV03,
): CodeGraphBindingV03 {
  const snapshot: CodeGraphSnapshotV03 = supplied?.snapshot ?? {
    repository_id: posix.basename(root.replaceAll('\\', '/')),
    worktree_digest: sourceDigest,
  };
  assertValidCodeGraphSnapshot(snapshot);
  const acceptedSources = normalizeAcceptedSources(supplied?.accepted_sources ?? files.map((file) => ({
    path: file.path,
    source_hash: file.source_hash,
  })));
  const acceptedByPath = new Map(acceptedSources.map((source) => [source.path, source.source_hash]));
  for (const file of files) {
    if (acceptedByPath.get(file.path) !== file.source_hash) {
      throw new PrimeContextError(
        'FRESHNESS_ERROR',
        'Local CodeGraph source does not match its accepted-source manifest',
      );
    }
  }
  return {
    snapshot: structuredClone(snapshot),
    accepted_sources: acceptedSources,
    accepted_source_digest: sha256(canonicalJson(acceptedSources)),
  };
}

function isBoundedGraphText(
  value: unknown,
  maximum: number,
  allowLineBreaks = false,
): value is string {
  if (typeof value !== 'string' || value.length > maximum) return false;
  return allowLineBreaks
    ? !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
    : !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertValidGraphLocator(value: unknown, filePaths: ReadonlySet<string>): asserts value is CodeGraphLocatorV03 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph locator is invalid');
  }
  const candidate = value as Partial<CodeGraphLocatorV03>;
  if (!isSafeGraphPath(candidate.path) || !filePaths.has(candidate.path)
    || !Number.isSafeInteger(candidate.start_line) || (candidate.start_line ?? 0) < 1
    || !Number.isSafeInteger(candidate.start_column) || (candidate.start_column ?? 0) < 1
    || !Number.isSafeInteger(candidate.end_line) || (candidate.end_line ?? 0) < 1
    || !Number.isSafeInteger(candidate.end_column) || (candidate.end_column ?? 0) < 1
    || (candidate.end_line as number) < (candidate.start_line as number)
    || ((candidate.end_line as number) === (candidate.start_line as number)
      && (candidate.end_column as number) < (candidate.start_column as number))) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph locator is invalid');
  }
}

function boundedLimit(
  name: keyof CodeGraphLimitsV03,
  value: number | undefined,
): number {
  const maximum = DEFAULT_CODEGRAPH_LIMITS_V03[name];
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new PrimeContextError(
      'CONFIG_ERROR',
      `Invalid CodeGraph limit: ${name}`,
      [`expected an integer from 1 through ${maximum}`],
    );
  }
  return resolved;
}

function resolveLimits(overrides: Partial<CodeGraphLimitsV03>): CodeGraphLimitsV03 {
  const allowed = new Set<keyof CodeGraphLimitsV03>([
    'maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxNodes', 'maxEdges',
  ]);
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key as keyof CodeGraphLimitsV03)) {
      throw new PrimeContextError('CONFIG_ERROR', `Unknown CodeGraph limit: ${key}`);
    }
  }
  return {
    maxFiles: boundedLimit('maxFiles', overrides.maxFiles),
    maxFileBytes: boundedLimit('maxFileBytes', overrides.maxFileBytes),
    maxTotalBytes: boundedLimit('maxTotalBytes', overrides.maxTotalBytes),
    maxNodes: boundedLimit('maxNodes', overrides.maxNodes),
    maxEdges: boundedLimit('maxEdges', overrides.maxEdges),
  };
}

function resolveRuntime(runtime: CodeGraphRuntimeV03): {
  loadTypeScript?: () => Promise<unknown>;
  monotonicNow: MonotonicNowV03;
} {
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
    throw new PrimeContextError('CONFIG_ERROR', 'Invalid CodeGraph runtime configuration');
  }
  const allowed = new Set(['loadTypeScript', 'monotonicNow']);
  for (const key of Object.keys(runtime)) {
    if (!allowed.has(key)) throw new PrimeContextError('CONFIG_ERROR', `Unknown CodeGraph runtime option: ${key}`);
  }
  if (runtime.loadTypeScript !== undefined && typeof runtime.loadTypeScript !== 'function') {
    throw new PrimeContextError('CONFIG_ERROR', 'CodeGraph TypeScript loader must be a function');
  }
  if (runtime.monotonicNow !== undefined && typeof runtime.monotonicNow !== 'function') {
    throw new PrimeContextError('CONFIG_ERROR', 'CodeGraph monotonic clock must be a function');
  }
  return {
    ...(runtime.loadTypeScript ? { loadTypeScript: runtime.loadTypeScript } : {}),
    monotonicNow: runtime.monotonicNow ?? systemMonotonicNowV03,
  };
}

function asTypeScriptModule(value: unknown): TypeScriptModule {
  const requiredFunctions = [
    'createSourceFile', 'forEachChild', 'canHaveModifiers', 'getModifiers',
    'isVariableDeclaration', 'isIdentifier', 'isStringLiteral', 'isNumericLiteral',
    'isFunctionDeclaration', 'isClassDeclaration', 'isInterfaceDeclaration',
    'isTypeAliasDeclaration', 'isEnumDeclaration', 'isMethodDeclaration',
    'isMethodSignature', 'isPropertyDeclaration', 'isPropertySignature',
    'isImportDeclaration', 'isNamedImports', 'isNamespaceImport',
    'isExportDeclaration', 'isCallExpression',
  ];
  if (typeof value !== 'object' || value === null
    || requiredFunctions.some((name) => typeof (value as Record<string, unknown>)[name] !== 'function')
    || typeof (value as Record<string, unknown>).ScriptKind !== 'object'
    || typeof (value as Record<string, unknown>).ScriptTarget !== 'object'
    || typeof (value as Record<string, unknown>).SyntaxKind !== 'object') {
    throw new PrimeContextError('CAPABILITY_ERROR', 'TypeScript CodeGraph capability is unavailable');
  }
  return value as TypeScriptModule;
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStableCodeBytes(root: string, path: string, maximum: number): Promise<StableCodeRead> {
  const resolvedRoot = resolve(root);
  const absolute = assertPathInsideRoot(resolvedRoot, path);
  try {
    await assertNoSymbolicLinkComponents(resolvedRoot, path);
    const pathBefore = await lstat(absolute);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new PrimeContextError('SECURITY_ERROR', 'CodeGraph sources must be regular files');
    }
    if (pathBefore.size > maximum) return { kind: 'oversize' };
    const handle = await open(absolute, 'r');
    try {
      const before = await handle.stat();
      if (!sameFileSnapshot(pathBefore, before)) {
        throw new PrimeContextError('SECURITY_ERROR', 'CodeGraph source changed before its bounded read');
      }
      const buffer = Buffer.alloc(Math.min(maximum + 1, before.size + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      const pathAfter = await lstat(absolute);
      await assertNoSymbolicLinkComponents(resolvedRoot, path);
      if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, pathAfter) || offset !== after.size) {
        throw new PrimeContextError('SECURITY_ERROR', 'CodeGraph source changed during its bounded read');
      }
      return offset > maximum
        ? { kind: 'oversize' }
        : { kind: 'content', bytes: buffer.subarray(0, offset) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof PrimeContextError) throw error;
    throw new PrimeContextError('IO_ERROR', 'Unable to read a CodeGraph source', [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

function scriptKind(ts: TypeScriptModule, path: string): TypeScript.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function language(ts: TypeScriptModule, path: string): CodeGraphLanguageV03 {
  return scriptKind(ts, path) === ts.ScriptKind.JS || scriptKind(ts, path) === ts.ScriptKind.JSX
    ? 'javascript'
    : 'typescript';
}

function locator(sourceFile: TypeScript.SourceFile, node: TypeScript.Node): CodeGraphLocatorV03 {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path: sourceFile.fileName,
    start_line: start.line + 1,
    start_column: start.character + 1,
    end_line: end.line + 1,
    end_column: end.character + 1,
  };
}

function fileLocator(sourceFile: TypeScript.SourceFile): CodeGraphLocatorV03 {
  const end = sourceFile.getLineAndCharacterOfPosition(sourceFile.end);
  return {
    path: sourceFile.fileName,
    start_line: 1,
    start_column: 1,
    end_line: end.line + 1,
    end_column: end.character + 1,
  };
}

function boundedExcerpt(sourceFile: TypeScript.SourceFile, node: TypeScript.Node): { text: string; truncated: boolean } {
  const allLines = node.getText(sourceFile).split(/\r\n|\n|\r/u);
  const lines = allLines.slice(0, MAX_EXCERPT_LINES);
  const characters = Array.from(lines.join('\n'));
  return {
    text: characters.slice(0, MAX_EXCERPT_CHARACTERS).join(''),
    truncated: allLines.length > MAX_EXCERPT_LINES || characters.length > MAX_EXCERPT_CHARACTERS,
  };
}

function hasModifier(ts: TypeScriptModule, node: TypeScript.Node, kind: TypeScript.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function isExported(ts: TypeScriptModule, node: TypeScript.Node): boolean {
  if (hasModifier(ts, node, ts.SyntaxKind.ExportKeyword) || hasModifier(ts, node, ts.SyntaxKind.DefaultKeyword)) return true;
  if (ts.isVariableDeclaration(node)) return isExported(ts, node.parent.parent);
  return false;
}

function declarationKind(ts: TypeScriptModule, node: TypeScript.Node): CodeGraphNodeKindV03 | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return 'variable';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return 'property';
  return undefined;
}

function declarationName(ts: TypeScriptModule, node: TypeScript.Node): string | undefined {
  if (!('name' in node)) return undefined;
  const named = node as TypeScript.Node & { name?: TypeScript.DeclarationName };
  if (!named.name) {
    return hasModifier(ts, node, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined;
  }
  if (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name) || ts.isNumericLiteral(named.name)) {
    return named.name.text;
  }
  return named.name.getText();
}

function expressionTarget(ts: TypeScriptModule, expression: TypeScript.Expression): { identifier?: string; target: string } {
  if (ts.isIdentifier(expression)) return { identifier: expression.text, target: expression.text };
  return { target: expression.getText() };
}

function isFunctionScope(ts: TypeScriptModule, node: TypeScript.Node): node is TypeScript.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function addBindingNames(
  ts: TypeScriptModule,
  name: TypeScript.BindingName,
  names: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) addBindingNames(ts, element.name, names);
  }
}

function functionScopeBindingNames(
  ts: TypeScriptModule,
  scope: TypeScript.FunctionLikeDeclaration,
): Set<string> {
  const names = new Set<string>();
  for (const parameter of scope.parameters) addBindingNames(ts, parameter.name, names);
  const body = scope.body;
  if (!body) return names;
  const collect = (node: TypeScript.Node): void => {
    if (node !== body && isFunctionScope(ts, node)) {
      if ('name' in node) {
        const declaration = node as TypeScript.FunctionLikeDeclaration & { name?: TypeScript.DeclarationName };
        if (declaration.name && ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) addBindingNames(ts, node.name, names);
    if (ts.isClassDeclaration(node) && node.name) names.add(node.name.text);
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingNames(ts, node.variableDeclaration.name, names);
    }
    ts.forEachChild(node, collect);
  };
  collect(body);
  return names;
}

function makeNodeId(path: string, kind: CodeGraphNodeKindV03, qualifiedName: string, where: CodeGraphLocatorV03): string {
  return `CGN-${sha256(`${path}\n${kind}\n${qualifiedName}\n${where.start_line}:${where.start_column}`).slice(7)}`;
}

function makeEdge(edge: Omit<CodeGraphEdgeV03, 'id'>): CodeGraphEdgeV03 {
  const identity = canonicalJson([
    edge.kind, edge.from_id, edge.to_id ?? '', edge.target,
    edge.locator.path, edge.locator.start_line, edge.locator.start_column,
    edge.locator.end_line, edge.locator.end_column,
  ]);
  return { id: `CGE-${sha256(identity).slice(7)}`, ...edge };
}

function parseFile(
  ts: TypeScriptModule,
  file: CodeGraphFileV03,
  content: string,
  assertWithinDeadline: () => void,
): ParsedCodeFile | undefined {
  assertWithinDeadline();
  const sourceFile = ts.createSourceFile(
    file.path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(ts, file.path),
  );
  assertWithinDeadline();
  const parseDiagnostics = (sourceFile as TypeScript.SourceFile & {
    parseDiagnostics?: readonly TypeScript.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) return undefined;

  const fileNodeId = `CGN-${sha256(`file\n${file.path}`).slice(7)}`;
  const nodes: CodeGraphNodeV03[] = [{
    id: fileNodeId,
    kind: 'file',
    name: file.path,
    qualified_name: file.path,
    locator: fileLocator(sourceFile),
    source_hash: file.source_hash,
    exported: false,
    excerpt: '',
    excerpt_truncated: false,
  }];
  const localSymbols = new Map<string, string>();
  const exportedSymbols = new Map<string, string>();
  const importedBindings = new Map<string, { imported: string; specifier: string }>();
  const imports: PendingEdge[] = [];
  const exports: PendingEdge[] = [];
  const calls: PendingCall[] = [];
  const containmentEdges: PendingEdge[] = [];

  const visit = (
    node: TypeScript.Node,
    containerId: string,
    containerName: string,
    depth: number,
    shadowedBindings: ReadonlySet<string>,
  ): void => {
    assertWithinDeadline();
    if (depth > MAX_AST_DEPTH) {
      throw new PrimeContextError('CAPABILITY_ERROR', 'CodeGraph syntax depth limit exceeded');
    }
    let nextContainerId = containerId;
    let nextContainerName = containerName;
    const kind = declarationKind(ts, node);
    const name = kind ? declarationName(ts, node) : undefined;
    if (kind && name && isBoundedGraphText(name, MAX_GRAPH_NAME_CHARACTERS)) {
      const qualifiedName = containerName ? `${containerName}.${name}` : name;
      if (!isBoundedGraphText(qualifiedName, MAX_GRAPH_TEXT_CHARACTERS)) {
        ts.forEachChild(node, (child) => visit(child, containerId, containerName, depth + 1, shadowedBindings));
        return;
      }
      const where = locator(sourceFile, node);
      const id = makeNodeId(file.path, kind, qualifiedName, where);
      const exported = isExported(ts, node);
      const excerpt = boundedExcerpt(sourceFile, node);
      nodes.push({
        id,
        kind,
        name,
        qualified_name: qualifiedName,
        locator: where,
        source_hash: file.source_hash,
        exported,
        excerpt: excerpt.text,
        excerpt_truncated: excerpt.truncated,
      });
      containmentEdges.push({
        kind: 'contains',
        fromId: containerId,
        toId: id,
        target: qualifiedName,
        locator: where,
      });
      if (!localSymbols.has(name)) localSymbols.set(name, id);
      if (exported && !exportedSymbols.has(name)) exportedSymbols.set(name, id);
      if (exported) {
        exports.push({
          kind: 'exports',
          fromId: fileNodeId,
          toId: id,
          target: qualifiedName,
          locator: where,
        });
      }
      nextContainerId = id;
      nextContainerName = qualifiedName;
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!isBoundedGraphText(specifier, MAX_GRAPH_TEXT_CHARACTERS)) {
        ts.forEachChild(node, (child) => visit(child, nextContainerId, nextContainerName, depth + 1, shadowedBindings));
        return;
      }
      imports.push({
        kind: 'imports', fromId: fileNodeId, target: specifier,
        locator: locator(sourceFile, node),
      });
      const clause = node.importClause;
      if (clause?.name) importedBindings.set(clause.name.text, { imported: 'default', specifier });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          importedBindings.set(element.name.text, {
            imported: element.propertyName?.text ?? element.name.text,
            specifier,
          });
        }
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        importedBindings.set(clause.namedBindings.name.text, { imported: '*', specifier });
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isBoundedGraphText(node.moduleSpecifier.text, MAX_GRAPH_TEXT_CHARACTERS)) {
        exports.push({
          kind: 'exports', fromId: fileNodeId, target: node.moduleSpecifier.text,
          locator: locator(sourceFile, node),
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const target = expressionTarget(ts, node.expression);
      if (isBoundedGraphText(target.target, MAX_GRAPH_TEXT_CHARACTERS)) {
        calls.push({
          fromId: containerId,
          target: target.target,
          ...(target.identifier ? { identifier: target.identifier } : {}),
          lexicallyShadowed: target.identifier ? shadowedBindings.has(target.identifier) : false,
          locator: locator(sourceFile, node.expression),
        });
      }
    }
    const childShadowedBindings = isFunctionScope(ts, node)
      ? new Set([...shadowedBindings, ...functionScopeBindingNames(ts, node)])
      : shadowedBindings;
    ts.forEachChild(node, (child) => (
      visit(child, nextContainerId, nextContainerName, depth + 1, childShadowedBindings)
    ));
  };
  ts.forEachChild(sourceFile, (node) => visit(node, fileNodeId, '', 1, new Set()));

  return {
    file,
    nodes,
    localSymbols,
    exportedSymbols,
    importedBindings,
    imports: [...imports, ...exports, ...containmentEdges],
    calls,
  };
}

function resolveLocalModule(fromPath: string, specifier: string, files: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (base === '..' || base.startsWith('../')) return undefined;
  const extension = posix.extname(base).toLowerCase();
  const stem = CODE_EXTENSIONS.has(extension) ? base.slice(0, -extension.length) : base;
  const candidates = [
    base,
    ...[...CODE_EXTENSIONS].map((candidateExtension) => `${stem}${candidateExtension}`),
    ...[...CODE_EXTENSIONS].map((candidateExtension) => `${base}/index${candidateExtension}`),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function graphDigestInput(graph: Omit<LocalCodeGraphV03, 'graph_digest'>): string {
  return canonicalJson(graph);
}

export function assertValidLocalCodeGraphV03(graph: LocalCodeGraphV03): LocalCodeGraphV03 {
  if (typeof graph !== 'object' || graph === null || graph.schema_version !== '0.3') {
    throw new PrimeContextError('VALIDATION_ERROR', 'Invalid local CodeGraph');
  }
  if (!Array.isArray(graph.files) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Invalid local CodeGraph collections');
  }
  if (typeof graph.binding !== 'object' || graph.binding === null) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph binding is invalid');
  }
  assertValidCodeGraphSnapshot(graph.binding.snapshot);
  const acceptedSources = normalizeAcceptedSources(graph.binding.accepted_sources);
  if (canonicalJson(acceptedSources) !== canonicalJson(graph.binding.accepted_sources)
    || !SHA256_PATTERN.test(graph.binding.accepted_source_digest)
    || graph.binding.accepted_source_digest !== sha256(canonicalJson(acceptedSources))) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph accepted-source binding is invalid');
  }
  const acceptedHashByPath = new Map(acceptedSources.map((source) => [source.path, source.source_hash]));
  if (graph.files.length > DEFAULT_CODEGRAPH_LIMITS_V03.maxFiles) {
    throw new PrimeContextError('CAPABILITY_ERROR', 'Local CodeGraph file count limit exceeded');
  }
  if (graph.nodes.length > DEFAULT_CODEGRAPH_LIMITS_V03.maxNodes) {
    throw new PrimeContextError('CAPABILITY_ERROR', 'Local CodeGraph node count limit exceeded');
  }
  if (graph.edges.length > DEFAULT_CODEGRAPH_LIMITS_V03.maxEdges) {
    throw new PrimeContextError('CAPABILITY_ERROR', 'Local CodeGraph edge count limit exceeded');
  }
  if (typeof graph.summary !== 'object' || graph.summary === null) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph summary does not match its content');
  }
  const summaryCounts: Array<keyof LocalCodeGraphV03['summary']> = [
    'discovered_path_count', 'excluded_path_count', 'candidate_file_count', 'file_count',
    'omitted_oversize_count', 'omitted_parse_error_count', 'omitted_sensitive_count',
    'total_source_bytes', 'node_count', 'edge_count',
  ];
  if (summaryCounts.some((key) => !isNonNegativeSafeInteger(graph.summary[key]))
    || graph.summary.file_count !== graph.files.length
    || graph.summary.node_count !== graph.nodes.length
    || graph.summary.edge_count !== graph.edges.length
    || graph.summary.candidate_file_count > DEFAULT_CODEGRAPH_LIMITS_V03.maxFiles
    || graph.summary.total_source_bytes > DEFAULT_CODEGRAPH_LIMITS_V03.maxTotalBytes
    || graph.summary.file_count + graph.summary.omitted_oversize_count
      + graph.summary.omitted_parse_error_count + graph.summary.omitted_sensitive_count
      > graph.summary.candidate_file_count) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph summary does not match its content');
  }

  const filePaths = new Set<string>();
  const fileIds = new Set<string>();
  const fileHashByPath = new Map<string, string>();
  let totalSourceBytes = 0;
  for (const file of graph.files) {
    if (typeof file !== 'object' || file === null || !FILE_ID_PATTERN.test(file.id)
      || fileIds.has(file.id) || !isSafeGraphPath(file.path) || filePaths.has(file.path)
      || !CODE_EXTENSIONS.has(posix.extname(file.path).toLowerCase())
      || (file.language !== 'typescript' && file.language !== 'javascript')
      || !SHA256_PATTERN.test(file.source_hash)
      || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0
      || file.size_bytes > DEFAULT_CODEGRAPH_LIMITS_V03.maxFileBytes) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph file metadata is invalid');
    }
    totalSourceBytes += file.size_bytes;
    if (!Number.isSafeInteger(totalSourceBytes) || totalSourceBytes > DEFAULT_CODEGRAPH_LIMITS_V03.maxTotalBytes) {
      throw new PrimeContextError('SECURITY_ERROR', 'Local CodeGraph source byte limit exceeded');
    }
    fileIds.add(file.id);
    filePaths.add(file.path);
    fileHashByPath.set(file.path, file.source_hash);
    if (acceptedHashByPath.get(file.path) !== file.source_hash) {
      throw new PrimeContextError('FRESHNESS_ERROR', 'Local CodeGraph file is absent from its accepted-source binding');
    }
  }
  if (totalSourceBytes !== graph.summary.total_source_bytes) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph source size does not match its summary');
  }

  const nodeIds = new Set<string>();
  const fileNodePaths = new Set<string>();
  let totalExcerptBytes = 0;
  for (const node of graph.nodes) {
    if (typeof node !== 'object' || node === null || !NODE_ID_PATTERN.test(node.id) || nodeIds.has(node.id)
      || !GRAPH_NODE_KINDS.has(node.kind) || !isBoundedGraphText(node.name, MAX_GRAPH_NAME_CHARACTERS)
      || !isBoundedGraphText(node.qualified_name, MAX_GRAPH_TEXT_CHARACTERS)
      || !SHA256_PATTERN.test(node.source_hash) || typeof node.exported !== 'boolean'
      || !isBoundedGraphText(node.excerpt, MAX_EXCERPT_CHARACTERS, true)
      || typeof node.excerpt_truncated !== 'boolean') {
      throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph node metadata is invalid');
    }
    assertValidGraphLocator(node.locator, filePaths);
    if (fileHashByPath.get(node.locator.path) !== node.source_hash
      || node.excerpt.split(/\r\n|\n|\r/u).length > MAX_EXCERPT_LINES
      || isSensitiveDocumentContent(`${node.name}\n${node.qualified_name}\n${node.excerpt}`)) {
      throw new PrimeContextError('SECURITY_ERROR', 'Local CodeGraph node contains sensitive or inconsistent source data');
    }
    if (node.kind === 'file') {
      if (node.name !== node.locator.path || node.qualified_name !== node.locator.path
        || node.excerpt !== '' || fileNodePaths.has(node.locator.path)) {
        throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph file node is invalid');
      }
      fileNodePaths.add(node.locator.path);
    }
    totalExcerptBytes += Buffer.byteLength(node.excerpt, 'utf8');
    if (!Number.isSafeInteger(totalExcerptBytes) || totalExcerptBytes > MAX_TOTAL_EXCERPT_BYTES) {
      throw new PrimeContextError('SECURITY_ERROR', 'Local CodeGraph excerpt byte limit exceeded');
    }
    nodeIds.add(node.id);
  }
  if (fileNodePaths.size !== graph.files.length) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph must contain one file node per source file');
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (typeof edge !== 'object' || edge === null || !EDGE_ID_PATTERN.test(edge.id) || edgeIds.has(edge.id)
      || !GRAPH_EDGE_KINDS.has(edge.kind) || !NODE_ID_PATTERN.test(edge.from_id) || !nodeIds.has(edge.from_id)
      || (edge.to_id !== undefined && (!NODE_ID_PATTERN.test(edge.to_id) || !nodeIds.has(edge.to_id)))
      || !isBoundedGraphText(edge.target, MAX_GRAPH_TEXT_CHARACTERS)) {
      throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph edge metadata is invalid');
    }
    assertValidGraphLocator(edge.locator, filePaths);
    if (isSensitiveDocumentContent(edge.target)) {
      throw new PrimeContextError('SECURITY_ERROR', 'Local CodeGraph edge contains sensitive data');
    }
    edgeIds.add(edge.id);
  }
  if (!SHA256_PATTERN.test(graph.source_digest) || !SHA256_PATTERN.test(graph.graph_digest)) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Invalid local CodeGraph digest');
  }
  const { graph_digest: suppliedDigest, ...withoutDigest } = graph;
  const actualDigest = sha256(graphDigestInput(withoutDigest));
  if (suppliedDigest !== actualDigest) {
    throw new PrimeContextError('VALIDATION_ERROR', 'Local CodeGraph digest does not match its content');
  }
  return graph;
}

export class NodeCodeGraphAdapter {
  private readonly excludes: string[];
  private readonly limits: CodeGraphLimitsV03;
  private readonly loadTypeScript?: () => Promise<unknown>;
  private readonly monotonicNow: MonotonicNowV03;

  constructor(
    excludes: string[] = [],
    limits: Partial<CodeGraphLimitsV03> = {},
    runtime: CodeGraphRuntimeV03 = {},
  ) {
    this.excludes = [...excludes];
    this.limits = resolveLimits(limits);
    const resolvedRuntime = resolveRuntime(runtime);
    if (resolvedRuntime.loadTypeScript) this.loadTypeScript = resolvedRuntime.loadTypeScript;
    this.monotonicNow = resolvedRuntime.monotonicNow;
  }

  async collect(root: string, collectionBinding?: CodeGraphCollectionBindingV03): Promise<LocalCodeGraphV03> {
    const assertWithinDeadline = createCooperativeDeadlineV03(
      this.monotonicNow,
      OPTIONAL_ADAPTER_DEADLINE_MS,
      'CodeGraph',
    );
    assertWithinDeadline();
    let ts: TypeScriptModule;
    try {
      const loaded = await (this.loadTypeScript ? this.loadTypeScript() : import('typescript'));
      ts = asTypeScriptModule(loaded);
    } catch (error) {
      if (error instanceof PrimeContextError && error.code === 'CAPABILITY_ERROR') throw error;
      throw new PrimeContextError('CAPABILITY_ERROR', 'TypeScript CodeGraph capability is unavailable');
    }
    assertWithinDeadline();
    const resolvedRoot = resolve(root);
    const walk = await new NodeFileSystemAdapter(this.excludes).walk(resolvedRoot);
    assertWithinDeadline();
    const candidates = walk.paths
      .filter((entry) => entry.kind === 'file' && CODE_EXTENSIONS.has(posix.extname(entry.relative_path).toLowerCase()))
      .sort((left, right) => ordinalCompare(left.relative_path, right.relative_path));
    assertWithinDeadline();
    if (candidates.length > this.limits.maxFiles) {
      throw new PrimeContextError('CAPABILITY_ERROR', 'CodeGraph file count limit exceeded', [
        `maximum=${this.limits.maxFiles}`,
      ]);
    }

    const parsedFiles: ParsedCodeFile[] = [];
    let omittedOversize = 0;
    let omittedParseError = 0;
    let omittedSensitive = 0;
    let totalSourceBytes = 0;
    let parsedNodeCount = 0;
    let parsedEdgeCount = 0;
    let totalExcerptBytes = 0;
    for (const candidate of candidates) {
      assertWithinDeadline();
      if (!isSafeGraphPath(candidate.relative_path)) {
        omittedParseError += 1;
        continue;
      }
      if ((candidate.size_bytes ?? 0) > this.limits.maxFileBytes) {
        omittedOversize += 1;
        continue;
      }
      const read = await readStableCodeBytes(resolvedRoot, candidate.relative_path, this.limits.maxFileBytes);
      if (read.kind === 'oversize') {
        omittedOversize += 1;
        continue;
      }
      totalSourceBytes += read.bytes.byteLength;
      if (!Number.isSafeInteger(totalSourceBytes) || totalSourceBytes > this.limits.maxTotalBytes) {
        throw new PrimeContextError('CAPABILITY_ERROR', 'CodeGraph total byte limit exceeded', [
          `maximum=${this.limits.maxTotalBytes}`,
        ]);
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes);
      } catch {
        omittedParseError += 1;
        continue;
      }
      if (isSensitiveDocumentContent(content)) {
        omittedSensitive += 1;
        continue;
      }
      const file: CodeGraphFileV03 = {
        id: `CGF-${sha256(candidate.relative_path).slice(7)}`,
        path: candidate.relative_path,
        language: language(ts, candidate.relative_path),
        source_hash: sha256(read.bytes),
        size_bytes: read.bytes.byteLength,
      };
      let parsed: ParsedCodeFile | undefined;
      try {
        parsed = parseFile(ts, file, content, assertWithinDeadline);
      } catch (error) {
        if (error instanceof PrimeContextError) throw error;
        omittedParseError += 1;
        continue;
      }
      assertWithinDeadline();
      if (!parsed) {
        omittedParseError += 1;
        continue;
      }
      const prospectiveNodes = parsedNodeCount + parsed.nodes.length;
      const prospectiveEdges = parsedEdgeCount + parsed.imports.length + parsed.calls.length;
      let parsedExcerptBytes = 0;
      for (const node of parsed.nodes) {
        assertWithinDeadline();
        parsedExcerptBytes += Buffer.byteLength(node.excerpt, 'utf8');
      }
      const prospectiveExcerptBytes = totalExcerptBytes + parsedExcerptBytes;
      if (prospectiveNodes > this.limits.maxNodes) {
        throw new PrimeContextError('CAPABILITY_ERROR', 'CodeGraph node limit exceeded', [`maximum=${this.limits.maxNodes}`]);
      }
      if (prospectiveEdges > this.limits.maxEdges) {
        throw new PrimeContextError('CAPABILITY_ERROR', 'CodeGraph edge limit exceeded', [`maximum=${this.limits.maxEdges}`]);
      }
      if (!Number.isSafeInteger(prospectiveExcerptBytes) || prospectiveExcerptBytes > MAX_TOTAL_EXCERPT_BYTES) {
        throw new PrimeContextError('CAPABILITY_ERROR', 'CodeGraph excerpt byte limit exceeded');
      }
      parsedNodeCount = prospectiveNodes;
      parsedEdgeCount = prospectiveEdges;
      totalExcerptBytes = prospectiveExcerptBytes;
      parsedFiles.push(parsed);
    }

    const files = parsedFiles.map((parsed) => parsed.file).sort((left, right) => ordinalCompare(left.path, right.path));
    const filePaths = new Set(files.map((file) => file.path));
    const parsedByPath = new Map(parsedFiles.map((parsed) => [parsed.file.path, parsed]));
    const nodes: CodeGraphNodeV03[] = [];
    for (const parsed of parsedFiles) {
      assertWithinDeadline();
      nodes.push(...parsed.nodes);
    }
    const edges: CodeGraphEdgeV03[] = [];
    for (const parsed of parsedFiles) {
      assertWithinDeadline();
      const fileNodeId = parsed.nodes[0]?.id;
      if (!fileNodeId) continue;
      for (const pending of parsed.imports) {
        assertWithinDeadline();
        let toId = pending.toId;
        if (pending.kind === 'imports') {
          const targetPath = resolveLocalModule(parsed.file.path, pending.target, filePaths);
          toId = targetPath ? parsedByPath.get(targetPath)?.nodes[0]?.id : undefined;
        }
        edges.push(makeEdge({
          kind: pending.kind,
          from_id: pending.fromId,
          ...(toId ? { to_id: toId } : {}),
          target: pending.target,
          locator: pending.locator,
        }));
      }
      for (const call of parsed.calls) {
        assertWithinDeadline();
        let toId = !call.lexicallyShadowed && call.identifier
          ? parsed.localSymbols.get(call.identifier)
          : undefined;
        const imported = !call.lexicallyShadowed && call.identifier
          ? parsed.importedBindings.get(call.identifier)
          : undefined;
        if (!toId && imported) {
          const targetPath = resolveLocalModule(parsed.file.path, imported.specifier, filePaths);
          const targetFile = targetPath ? parsedByPath.get(targetPath) : undefined;
          toId = imported.imported === '*'
            ? targetFile?.nodes[0]?.id
            : targetFile?.exportedSymbols.get(imported.imported);
        }
        edges.push(makeEdge({
          kind: 'calls',
          from_id: call.fromId,
          ...(toId ? { to_id: toId } : {}),
          target: call.target,
          locator: call.locator,
        }));
      }
    }

    assertWithinDeadline();
    nodes.sort((left, right) => (
      ordinalCompare(left.locator.path, right.locator.path)
      || left.locator.start_line - right.locator.start_line
      || left.locator.start_column - right.locator.start_column
      || ordinalCompare(left.kind, right.kind)
      || ordinalCompare(left.id, right.id)
    ));
    edges.sort((left, right) => (
      ordinalCompare(left.kind, right.kind)
      || ordinalCompare(left.from_id, right.from_id)
      || ordinalCompare(left.to_id ?? '', right.to_id ?? '')
      || ordinalCompare(left.target, right.target)
      || ordinalCompare(left.id, right.id)
    ));
    assertWithinDeadline();
    if (nodes.length > this.limits.maxNodes) {
      throw new PrimeContextError('CAPABILITY_ERROR', 'CodeGraph node limit exceeded', [`maximum=${this.limits.maxNodes}`]);
    }
    if (edges.length > this.limits.maxEdges) {
      throw new PrimeContextError('CAPABILITY_ERROR', 'CodeGraph edge limit exceeded', [`maximum=${this.limits.maxEdges}`]);
    }

    let indexedSourceBytes = 0;
    for (const file of files) {
      assertWithinDeadline();
      indexedSourceBytes += file.size_bytes;
    }
    const summary = {
      discovered_path_count: walk.paths.length + walk.excluded_path_count,
      excluded_path_count: walk.excluded_path_count,
      candidate_file_count: candidates.length,
      file_count: files.length,
      omitted_oversize_count: omittedOversize,
      omitted_parse_error_count: omittedParseError,
      omitted_sensitive_count: omittedSensitive,
      total_source_bytes: indexedSourceBytes,
      node_count: nodes.length,
      edge_count: edges.length,
    };
    const sourceDigest = sha256(canonicalJson({
      files: files.map(({ path, source_hash, size_bytes }) => ({ path, source_hash, size_bytes })),
      candidate_file_count: summary.candidate_file_count,
      omitted_oversize_count: omittedOversize,
      omitted_parse_error_count: omittedParseError,
      omitted_sensitive_count: omittedSensitive,
    }));
    const binding = resolveGraphBinding(resolvedRoot, sourceDigest, files, collectionBinding);
    const withoutGraphDigest: Omit<LocalCodeGraphV03, 'graph_digest'> = {
      schema_version: '0.3',
      source_digest: sourceDigest,
      binding,
      files,
      nodes,
      edges,
      summary,
    };
    assertWithinDeadline();
    const graph = assertValidLocalCodeGraphV03({
      ...withoutGraphDigest,
      graph_digest: sha256(graphDigestInput(withoutGraphDigest)),
    });
    assertWithinDeadline();
    return graph;
  }

}

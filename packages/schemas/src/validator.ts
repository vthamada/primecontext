import { metricNumericFields, taskIdPattern, taskTypes } from './schemas.js';
import { documentAuthorities, documentMatchFields } from './document-schemas.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type Obj = Record<string, unknown>;

const taskIdRegex = new RegExp(taskIdPattern);
const MAX_RUNTIME_JSON_DEPTH = 64;
const MAX_RUNTIME_JSON_VALUES = 100_000;

interface JsonValidationState {
  remainingValues: number;
  valueLimitReported: boolean;
}

function isJsonObject(value: unknown): value is Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectAt(value: unknown, path: string, errors: string[]): Obj | undefined {
  if (!isJsonObject(value)) {
    errors.push(`${path} must be a JSON object`);
    return undefined;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      errors.push(`${path} must not contain symbol properties`);
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      errors.push(`${path}.${key} must be enumerable to round-trip through JSON`);
      return undefined;
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      errors.push(`${path}.${key} must be a data property, not an accessor`);
      return undefined;
    }
  }
  return value;
}

function required(obj: Obj, keys: readonly string[], path: string, errors: string[]): void {
  for (const key of keys) {
    if (!Object.hasOwn(obj, key)) errors.push(`${path}.${key} is required`);
  }
}

function stringField(obj: Obj, key: string, path: string, errors: string[], requiredField = false): void {
  const value = obj[key];
  if (value === undefined && !requiredField) return;
  if (typeof value !== 'string' || value.length === 0) errors.push(`${path}.${key} must be a non-empty string`);
}

export function isValidTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && taskIdRegex.test(value);
}

function taskIdField(obj: Obj, path: string, errors: string[]): void {
  if (!isValidTaskId(obj.task_id)) {
    errors.push(`${path}.task_id must be a safe identifier of 1-128 ASCII letters, digits, dots, underscores, or hyphens`);
  }
}

function forEachDenseArray(
  value: unknown[],
  path: string,
  errors: string[],
  visit: (item: unknown, index: number) => void,
): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    errors.push(`${path} must be a plain JSON array`);
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      errors.push(`${path}[${index}] must be present; sparse arrays are not valid JSON input`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      errors.push(`${path}[${index}] must be an enumerable data item, not an accessor`);
      continue;
    }
    visit(descriptor.value as unknown, index);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      errors.push(`${path} must not contain symbol properties`);
      continue;
    }
    if (key === 'length') continue;
    if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) continue;
    errors.push(`${path}.${key} is not representable in a JSON array`);
  }
}

function stringArray(value: unknown, path: string, errors: string[], minItems = 0): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length < minItems) errors.push(`${path} must contain at least ${minItems} item(s)`);
  forEachDenseArray(value, path, errors, (item, index) => {
    if (typeof item !== 'string' || item.length === 0) errors.push(`${path}[${index}] must be a non-empty string`);
  });
}

function validateJsonValue(
  value: unknown,
  path: string,
  errors: string[],
  ancestors = new Set<object>(),
  depth = 0,
  state: JsonValidationState = { remainingValues: MAX_RUNTIME_JSON_VALUES, valueLimitReported: false },
): void {
  if (state.remainingValues <= 0) {
    if (!state.valueLimitReported) {
      errors.push(`${path} exceeds the ${MAX_RUNTIME_JSON_VALUES} JSON value limit`);
      state.valueLimitReported = true;
    }
    return;
  }
  state.remainingValues -= 1;
  if (depth > MAX_RUNTIME_JSON_DEPTH) {
    errors.push(`${path} exceeds the ${MAX_RUNTIME_JSON_DEPTH} nesting depth limit`);
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path} must be a finite JSON number`);
    return;
  }
  if (typeof value !== 'object') {
    errors.push(`${path} must contain only JSON-compatible values`);
    return;
  }
  if (ancestors.has(value)) {
    errors.push(`${path} must not contain a circular reference`);
    return;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > state.remainingValues) {
      errors.push(`${path} exceeds the ${MAX_RUNTIME_JSON_VALUES} JSON value limit`);
      state.valueLimitReported = true;
      state.remainingValues = 0;
      ancestors.delete(value);
      return;
    }
    forEachDenseArray(value, path, errors, (item, index) => validateJsonValue(item, `${path}[${index}]`, errors, ancestors, depth + 1, state));
    ancestors.delete(value);
    return;
  }

  if (!isJsonObject(value)) {
    errors.push(`${path} must contain only plain JSON objects`);
    ancestors.delete(value);
    return;
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length > state.remainingValues) {
    errors.push(`${path} exceeds the ${MAX_RUNTIME_JSON_VALUES} JSON value limit`);
    state.valueLimitReported = true;
    state.remainingValues = 0;
    ancestors.delete(value);
    return;
  }
  for (const key of keys) {
    if (typeof key !== 'string') {
      errors.push(`${path} must not contain symbol properties`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      errors.push(`${path}.${key} must be enumerable to round-trip through JSON`);
      continue;
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      errors.push(`${path}.${key} must be a data property, not an accessor`);
      continue;
    }
    validateJsonValue(descriptor.value as unknown, `${path}.${key}`, errors, ancestors, depth + 1, state);
  }
  ancestors.delete(value);
}

function nonNegativeInt(value: unknown, path: string, errors: string[], positive = false): void {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
    errors.push(`${path} must be ${positive ? 'a positive' : 'a non-negative'} safe integer`);
  }
}

function rejectUnknown(obj: Obj, allowed: readonly string[], path: string, errors: string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!set.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

function finish(errors: string[]): ValidationResult {
  return { valid: errors.length === 0, errors };
}

function validateContextBudgetAt(value: unknown, path: string, errors: string[]): void {
  const obj = objectAt(value, path, errors);
  if (!obj) return;
  required(obj, ['initial_tokens', 'soft_limit_tokens', 'hard_limit_tokens'], path, errors);
  rejectUnknown(obj, ['initial_tokens', 'soft_limit_tokens', 'hard_limit_tokens'], path, errors);
  for (const key of ['initial_tokens', 'soft_limit_tokens', 'hard_limit_tokens'] as const) {
    nonNegativeInt(obj[key], `${path}.${key}`, errors, true);
  }
  if (
    Number.isInteger(obj.initial_tokens)
    && Number.isInteger(obj.soft_limit_tokens)
    && Number.isInteger(obj.hard_limit_tokens)
  ) {
    const initial = obj.initial_tokens as number;
    const soft = obj.soft_limit_tokens as number;
    const hard = obj.hard_limit_tokens as number;
    if (initial > soft) errors.push(`${path} initial_tokens must be <= soft_limit_tokens`);
    if (soft > hard) errors.push(`${path} soft_limit_tokens must be <= hard_limit_tokens`);
  }
}

export function validateContextBudget(value: unknown): ValidationResult {
  const errors: string[] = [];
  validateContextBudgetAt(value, '$.context_budget', errors);
  return finish(errors);
}

export function validateTaskCapsule(value: unknown): ValidationResult {
  const errors: string[] = [];
  const obj = objectAt(value, '$', errors);
  if (!obj) return finish(errors);
  const allowed = ['schema_version', 'task_id', 'goal', 'task_type', 'module', 'priority', 'boundaries', 'decisions', 'contracts', 'documents', 'code_targets', 'acceptance', 'context_budget', 'worktree', 'metadata'];
  rejectUnknown(obj, allowed, '$', errors);
  required(obj, ['schema_version', 'task_id', 'goal', 'task_type', 'boundaries', 'acceptance', 'context_budget'], '$', errors);
  if (obj.schema_version !== '0.1') errors.push('$.schema_version must equal 0.1');
  taskIdField(obj, '$', errors);
  stringField(obj, 'goal', '$', errors, true);
  if (!(taskTypes as readonly unknown[]).includes(obj.task_type)) errors.push('$.task_type is invalid');
  stringField(obj, 'module', '$', errors);
  stringField(obj, 'priority', '$', errors);

  const boundaries = objectAt(obj.boundaries, '$.boundaries', errors);
  if (boundaries) {
    rejectUnknown(boundaries, ['allowed_paths', 'forbidden_paths'], '$.boundaries', errors);
    required(boundaries, ['allowed_paths', 'forbidden_paths'], '$.boundaries', errors);
    stringArray(boundaries.allowed_paths, '$.boundaries.allowed_paths', errors);
    stringArray(boundaries.forbidden_paths, '$.boundaries.forbidden_paths', errors);
  }

  if (obj.decisions !== undefined) {
    if (!Array.isArray(obj.decisions)) {
      errors.push('$.decisions must be an array');
    } else {
      forEachDenseArray(obj.decisions, '$.decisions', errors, (decision, index) => {
        const path = `$.decisions[${index}]`;
        const item = objectAt(decision, path, errors);
        if (!item) return;
        rejectUnknown(item, ['source', 'summary'], path, errors);
        required(item, ['source', 'summary'], path, errors);
        stringField(item, 'source', path, errors, true);
        stringField(item, 'summary', path, errors, true);
      });
    }
  }

  for (const key of ['contracts', 'documents', 'code_targets'] as const) {
    if (obj[key] !== undefined) stringArray(obj[key], `$.${key}`, errors);
  }
  stringArray(obj.acceptance, '$.acceptance', errors, 1);
  validateContextBudgetAt(obj.context_budget, '$.context_budget', errors);

  if (obj.worktree !== undefined) {
    const worktree = objectAt(obj.worktree, '$.worktree', errors);
    if (worktree) {
      rejectUnknown(worktree, ['root', 'branch', 'head'], '$.worktree', errors);
      required(worktree, ['root'], '$.worktree', errors);
      stringField(worktree, 'root', '$.worktree', errors, true);
      stringField(worktree, 'branch', '$.worktree', errors);
      stringField(worktree, 'head', '$.worktree', errors);
    }
  }
  if (obj.metadata !== undefined) {
    const metadata = objectAt(obj.metadata, '$.metadata', errors);
    if (metadata) validateJsonValue(metadata, '$.metadata', errors);
  }
  return finish(errors);
}

export function validateCompactHandoff(value: unknown): ValidationResult {
  const errors: string[] = [];
  const obj = objectAt(value, '$', errors);
  if (!obj) return finish(errors);
  const allowed = ['schema_version', 'task_id', 'status', 'commit', 'changed_files', 'interfaces_added', 'decisions', 'tests', 'risks', 'next_unblocked', 'artifacts', 'metrics_ref'];
  rejectUnknown(obj, allowed, '$', errors);
  required(obj, ['schema_version', 'task_id', 'status', 'changed_files', 'tests', 'risks', 'next_unblocked'], '$', errors);
  if (obj.schema_version !== '0.1') errors.push('$.schema_version must equal 0.1');
  taskIdField(obj, '$', errors);
  if (!['PASS', 'FAIL', 'PARTIAL', 'BLOCKED'].includes(obj.status as string)) errors.push('$.status is invalid');
  stringField(obj, 'commit', '$', errors);
  for (const key of ['changed_files', 'interfaces_added', 'decisions', 'risks', 'next_unblocked', 'artifacts'] as const) {
    if (obj[key] !== undefined) stringArray(obj[key], `$.${key}`, errors);
  }
  stringField(obj, 'metrics_ref', '$', errors);
  const tests = objectAt(obj.tests, '$.tests', errors);
  if (tests) {
    rejectUnknown(tests, ['passed', 'failed', 'skipped'], '$.tests', errors);
    required(tests, ['passed', 'failed'], '$.tests', errors);
    nonNegativeInt(tests.passed, '$.tests.passed', errors);
    nonNegativeInt(tests.failed, '$.tests.failed', errors);
    if (tests.skipped !== undefined) nonNegativeInt(tests.skipped, '$.tests.skipped', errors);
  }
  return finish(errors);
}

export function validateRepoMap(value: unknown): ValidationResult {
  const errors: string[] = [];
  const obj = objectAt(value, '$', errors);
  if (!obj) return finish(errors);
  rejectUnknown(obj, ['schema_version', 'generated_at', 'repository', 'modules', 'summary'], '$', errors);
  required(obj, ['schema_version', 'generated_at', 'repository', 'modules', 'summary'], '$', errors);
  if (obj.schema_version !== '0.1') errors.push('$.schema_version must equal 0.1');
  stringField(obj, 'generated_at', '$', errors, true);

  const repository = objectAt(obj.repository, '$.repository', errors);
  if (repository) {
    rejectUnknown(repository, ['root', 'name', 'branch', 'head'], '$.repository', errors);
    required(repository, ['root', 'name'], '$.repository', errors);
    stringField(repository, 'root', '$.repository', errors, true);
    stringField(repository, 'name', '$.repository', errors, true);
    stringField(repository, 'branch', '$.repository', errors);
    stringField(repository, 'head', '$.repository', errors);
  }

  const moduleIds = new Set<string>();
  if (!Array.isArray(obj.modules)) {
    errors.push('$.modules must be an array');
  } else {
    forEachDenseArray(obj.modules, '$.modules', errors, (module, index) => {
      const path = `$.modules[${index}]`;
      const item = objectAt(module, path, errors);
      if (!item) return;
      rejectUnknown(item, ['id', 'path', 'kind', 'role', 'evidence'], path, errors);
      required(item, ['id', 'path', 'kind', 'role', 'evidence'], path, errors);
      stringField(item, 'id', path, errors, true);
      stringField(item, 'path', path, errors, true);
      stringField(item, 'role', path, errors, true);
      if (typeof item.id === 'string' && item.id.length > 0) {
        if (moduleIds.has(item.id)) errors.push(`${path}.id contains duplicate module id ${item.id}`);
        moduleIds.add(item.id);
      }
      if (!['workspace_package', 'source', 'tests', 'documentation', 'configuration', 'examples', 'benchmarks', 'other'].includes(item.kind as string)) {
        errors.push(`${path}.kind is invalid`);
      }
      stringArray(item.evidence, `${path}.evidence`, errors);
    });
  }

  const summary = objectAt(obj.summary, '$.summary', errors);
  if (summary) {
    rejectUnknown(summary, ['module_count', 'discovered_path_count', 'excluded_path_count'], '$.summary', errors);
    required(summary, ['module_count', 'discovered_path_count', 'excluded_path_count'], '$.summary', errors);
    for (const key of ['module_count', 'discovered_path_count', 'excluded_path_count'] as const) {
      nonNegativeInt(summary[key], `$.summary.${key}`, errors);
    }
    if (Array.isArray(obj.modules) && Number.isInteger(summary.module_count) && summary.module_count !== obj.modules.length) {
      errors.push('$.summary.module_count must equal $.modules.length');
    }
  }
  return finish(errors);
}

export function validateMetricRecord(value: unknown): ValidationResult {
  const errors: string[] = [];
  const obj = objectAt(value, '$', errors);
  if (!obj) return finish(errors);
  const allowed = ['schema_version', 'task_id', 'recorded_at', 'arm', ...metricNumericFields, 'test_status', 'review_status', 'completion_status', 'estimated_fields'];
  rejectUnknown(obj, allowed, '$', errors);
  required(obj, ['schema_version', 'task_id', 'recorded_at'], '$', errors);
  if (obj.schema_version !== '0.1') errors.push('$.schema_version must equal 0.1');
  taskIdField(obj, '$', errors);
  stringField(obj, 'recorded_at', '$', errors, true);
  if (obj.arm !== undefined && !['A', 'B'].includes(obj.arm as string)) errors.push('$.arm is invalid');
  for (const key of metricNumericFields) {
    if (obj[key] !== undefined) nonNegativeInt(obj[key], `$.${key}`, errors);
  }
  if (obj.test_status !== undefined && !['PASS', 'FAIL', 'UNKNOWN'].includes(obj.test_status as string)) {
    errors.push('$.test_status is invalid');
  }
  if (obj.review_status !== undefined && !['PASS', 'FAIL', 'UNKNOWN'].includes(obj.review_status as string)) {
    errors.push('$.review_status is invalid');
  }
  if (obj.completion_status !== undefined && !['PASS', 'FAIL', 'UNKNOWN'].includes(obj.completion_status as string)) {
    errors.push('$.completion_status is invalid');
  }
  if (obj.estimated_fields !== undefined) {
    if (!Array.isArray(obj.estimated_fields)) {
      errors.push('$.estimated_fields must be an array');
    } else {
      const seen = new Set<string>();
      forEachDenseArray(obj.estimated_fields, '$.estimated_fields', errors, (field, index) => {
        if (!(metricNumericFields as readonly unknown[]).includes(field)) {
          errors.push(`$.estimated_fields[${index}] is invalid`);
          return;
        }
        const name = field as string;
        if (seen.has(name)) errors.push(`$.estimated_fields contains duplicate ${name}`);
        seen.add(name);
        if (!Object.hasOwn(obj, name) || obj[name] === undefined) {
          errors.push(`$.estimated_fields[${index}] references ${name}, which must be present as a measurement`);
        }
      });
    }
  }
  return finish(errors);
}

export function validatePrimeContextConfig(value: unknown): ValidationResult {
  const errors: string[] = [];
  const obj = objectAt(value, '$', errors);
  if (!obj) return finish(errors);
  rejectUnknown(obj, ['schema_version', 'state_dir', 'exclude', 'budgets'], '$', errors);
  required(obj, ['schema_version', 'state_dir', 'exclude', 'budgets'], '$', errors);
  if (obj.schema_version !== '0.1') errors.push('$.schema_version must equal 0.1');
  stringField(obj, 'state_dir', '$', errors, true);
  stringArray(obj.exclude, '$.exclude', errors);

  const budgets = objectAt(obj.budgets, '$.budgets', errors);
  if (budgets) {
    rejectUnknown(budgets, taskTypes, '$.budgets', errors);
    required(budgets, taskTypes, '$.budgets', errors);
    for (const taskType of taskTypes) {
      if (Object.hasOwn(budgets, taskType)) {
        validateContextBudgetAt(budgets[taskType], `$.budgets.${taskType}`, errors);
      }
    }
  }
  return finish(errors);
}

const DOCUMENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DOCUMENT_ID_PATTERN = /^DOC-[0-9a-f]{64}$/;
const WINDOWS_DEVICE_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])[ .]*(?:\.|$)/i;
const DOCUMENT_AUTHORITY_SET = new Set<string>(documentAuthorities);
const DOCUMENT_MATCH_FIELD_SET = new Set<string>(documentMatchFields);
const MAX_NORMALIZED_DOCUMENT_TEXT = 8192;

function isRfc3339UtcInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (daysInMonth[month - 1] as number)) return false;
  return second !== 60 || (hour === 23 && minute === 59 && ((month === 6 && day === 30) || (month === 12 && day === 31)));
}

function boundedString(
  value: unknown,
  path: string,
  errors: string[],
  maximum: number,
  allowEmpty = false,
): value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    errors.push(`${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
    return false;
  }
  if ([...value].length > maximum) errors.push(`${path} must contain at most ${maximum} characters`);
  return true;
}

function boundedInteger(value: unknown, path: string, errors: string[], minimum: number, maximum: number): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    errors.push(`${path} must be a safe integer from ${minimum} through ${maximum}`);
    return false;
  }
  return true;
}

interface DocumentStringArrayOptions {
  minItems?: number;
  maxItems: number;
  maxLength: number;
  allowed?: ReadonlySet<string>;
  sorted?: boolean;
}

function documentStringArray(
  value: unknown,
  path: string,
  errors: string[],
  options: DocumentStringArrayOptions,
): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  if (value.length < (options.minItems ?? 0)) errors.push(`${path} must contain at least ${options.minItems ?? 0} item(s)`);
  if (value.length > options.maxItems) errors.push(`${path} must contain at most ${options.maxItems} item(s)`);
  const strings: string[] = [];
  const seen = new Set<string>();
  forEachDenseArray(value, path, errors, (item, index) => {
    if (!boundedString(item, `${path}[${index}]`, errors, options.maxLength)) return;
    strings.push(item);
    if (seen.has(item)) errors.push(`${path} contains duplicate ${item}`);
    seen.add(item);
    if (options.allowed && !options.allowed.has(item)) errors.push(`${path}[${index}] is invalid`);
  });
  if (options.sorted) {
    for (let index = 1; index < strings.length; index += 1) {
      if ((strings[index - 1] as string) >= (strings[index] as string)) {
        errors.push(`${path} must be unique and sorted in ordinal order`);
        break;
      }
    }
  }
  return strings;
}

function validateDocumentHash(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string' || !DOCUMENT_HASH_PATTERN.test(value)) {
    errors.push(`${path} must be a lowercase sha256 digest`);
    return false;
  }
  return true;
}

function validateDocumentId(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string' || !DOCUMENT_ID_PATTERN.test(value)) {
    errors.push(`${path} must be DOC- followed by 64 lowercase hexadecimal characters`);
    return false;
  }
  return true;
}

function isSafeMarkdownPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > 1024) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || /[<>"|?*]/.test(value) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => /[. ]$/.test(segment) || WINDOWS_DEVICE_SEGMENT_PATTERN.test(segment))) return false;
  return value.toLowerCase().endsWith('.md');
}

function validateMarkdownPath(value: unknown, path: string, errors: string[]): value is string {
  if (!isSafeMarkdownPath(value)) {
    errors.push(`${path} must be a safe repository-relative Markdown path using / separators`);
    return false;
  }
  return true;
}

function normalizedDocumentTerms(value: string): string[] {
  const matches = value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of matches) {
    if (seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}

function normalizeDocumentTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function validateAuthorityBasis(value: unknown, path: string, errors: string[]): void {
  const basis = objectAt(value, path, errors);
  if (!basis) return;
  if (basis.kind === 'convention') {
    rejectUnknown(basis, ['kind', 'rule_id'], path, errors);
    required(basis, ['kind', 'rule_id'], path, errors);
    boundedString(basis.rule_id, `${path}.rule_id`, errors, 128);
    return;
  }
  if (basis.kind === 'default') {
    rejectUnknown(basis, ['kind'], path, errors);
    required(basis, ['kind'], path, errors);
    return;
  }
  errors.push(`${path}.kind must be convention or default`);
}

interface ValidatedCatalogDocument {
  id?: string;
  path?: string;
  title?: string;
  authority?: string;
  sourceHash?: string;
  sizeBytes?: number;
}

function validateCatalogDocument(value: unknown, path: string, errors: string[]): ValidatedCatalogDocument {
  const result: ValidatedCatalogDocument = {};
  const document = objectAt(value, path, errors);
  if (!document) return result;
  const allowed = [
    'id', 'path', 'format', 'title', 'authority', 'authority_basis',
    'modules', 'topics', 'source_hash', 'size_bytes',
  ];
  rejectUnknown(document, allowed, path, errors);
  required(document, allowed, path, errors);
  if (validateDocumentId(document.id, `${path}.id`, errors)) result.id = document.id;
  if (validateMarkdownPath(document.path, `${path}.path`, errors)) result.path = document.path;
  if (document.format !== 'markdown') errors.push(`${path}.format must equal markdown`);
  if (boundedString(document.title, `${path}.title`, errors, 256)) {
    if (document.title.trim().length === 0) errors.push(`${path}.title must contain non-whitespace text`);
    else result.title = document.title;
  }
  if (typeof document.authority !== 'string' || !DOCUMENT_AUTHORITY_SET.has(document.authority)) {
    errors.push(`${path}.authority is invalid`);
  } else {
    result.authority = document.authority;
  }
  validateAuthorityBasis(document.authority_basis, `${path}.authority_basis`, errors);
  documentStringArray(document.modules, `${path}.modules`, errors, { maxItems: 32, maxLength: 128, sorted: true });
  documentStringArray(document.topics, `${path}.topics`, errors, { maxItems: 32, maxLength: 128, sorted: true });
  if (validateDocumentHash(document.source_hash, `${path}.source_hash`, errors)) result.sourceHash = document.source_hash;
  if (boundedInteger(document.size_bytes, `${path}.size_bytes`, errors, 0, 512 * 1024)) result.sizeBytes = document.size_bytes;
  return result;
}

function validateDocumentFilters(
  value: unknown,
  path: string,
  errors: string[],
  requiredFields: boolean,
): { authorities: string[]; modules: string[]; topics: string[] } | undefined {
  if (value === undefined && !requiredFields) return { authorities: [], modules: [], topics: [] };
  const filters = objectAt(value, path, errors);
  if (!filters) return undefined;
  rejectUnknown(filters, ['authorities', 'modules', 'topics'], path, errors);
  if (requiredFields) required(filters, ['authorities', 'modules', 'topics'], path, errors);
  const authorities = filters.authorities === undefined && !requiredFields
    ? []
    : documentStringArray(filters.authorities, `${path}.authorities`, errors, {
      maxItems: 32, maxLength: 128, allowed: DOCUMENT_AUTHORITY_SET,
    }) ?? [];
  const modules = filters.modules === undefined && !requiredFields
    ? []
    : documentStringArray(filters.modules, `${path}.modules`, errors, { maxItems: 32, maxLength: 128 }) ?? [];
  const topics = filters.topics === undefined && !requiredFields
    ? []
    : documentStringArray(filters.topics, `${path}.topics`, errors, { maxItems: 32, maxLength: 128 }) ?? [];
  return { authorities, modules, topics };
}

function validateSearchText(value: unknown, path: string, errors: string[]): string[] {
  if (!boundedString(value, path, errors, 1024)) return [];
  if (new TextEncoder().encode(value).byteLength > 1024) errors.push(`${path} must contain at most 1024 UTF-8 bytes`);
  const terms = normalizedDocumentTerms(value);
  if (terms.length === 0) errors.push(`${path} must contain at least one Unicode letter or number`);
  if (terms.length > 32) errors.push(`${path} must contain at most 32 distinct normalized terms`);
  return terms;
}

export function validateDocumentCatalog(value: unknown): ValidationResult {
  const errors: string[] = [];
  const catalog = objectAt(value, '$', errors);
  if (!catalog) return finish(errors);
  rejectUnknown(catalog, ['schema_version', 'generated_at', 'catalog_digest', 'worktree', 'documents', 'summary'], '$', errors);
  required(catalog, ['schema_version', 'generated_at', 'catalog_digest', 'documents', 'summary'], '$', errors);
  if (catalog.schema_version !== '0.2') errors.push('$.schema_version must equal 0.2');
  if (!isRfc3339UtcInstant(catalog.generated_at)) {
    errors.push('$.generated_at must be an RFC 3339 UTC instant');
  }
  validateDocumentHash(catalog.catalog_digest, '$.catalog_digest', errors);

  if (catalog.worktree !== undefined) {
    const worktreeValue = objectAt(catalog.worktree, '$.worktree', errors);
    if (worktreeValue) {
      rejectUnknown(worktreeValue, ['branch', 'head'], '$.worktree', errors);
      if (!Object.hasOwn(worktreeValue, 'branch') && !Object.hasOwn(worktreeValue, 'head')) {
        errors.push('$.worktree must contain branch or head');
      }
      if (worktreeValue.branch !== undefined) boundedString(worktreeValue.branch, '$.worktree.branch', errors, 512);
      if (worktreeValue.head !== undefined) boundedString(worktreeValue.head, '$.worktree.head', errors, 128);
    }
  }

  const validatedDocuments: ValidatedCatalogDocument[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  let totalSourceBytes = 0;
  if (!Array.isArray(catalog.documents)) {
    errors.push('$.documents must be an array');
  } else {
    if (catalog.documents.length > 4096) errors.push('$.documents must contain at most 4096 documents');
    forEachDenseArray(catalog.documents, '$.documents', errors, (item, index) => {
      const document = validateCatalogDocument(item, `$.documents[${index}]`, errors);
      validatedDocuments.push(document);
      if (document.id) {
        if (ids.has(document.id)) errors.push(`$.documents[${index}].id duplicates ${document.id}`);
        ids.add(document.id);
      }
      if (document.path) {
        if (paths.has(document.path)) errors.push(`$.documents[${index}].path duplicates ${document.path}`);
        paths.add(document.path);
        const previousPath = validatedDocuments[index - 1]?.path;
        if (previousPath !== undefined && previousPath >= document.path) {
          errors.push('$.documents must be unique and sorted by path in ordinal order');
        }
      }
      if (document.sizeBytes !== undefined) totalSourceBytes += document.sizeBytes;
    });
  }
  if (totalSourceBytes > 64 * 1024 * 1024) errors.push('$.documents exceed the 64 MiB total source limit');

  const summary = objectAt(catalog.summary, '$.summary', errors);
  if (summary) {
    const keys = [
      'discovered_path_count', 'excluded_path_count', 'candidate_document_count',
      'document_count', 'omitted_document_count', 'total_source_bytes',
    ];
    rejectUnknown(summary, keys, '$.summary', errors);
    required(summary, keys, '$.summary', errors);
    boundedInteger(summary.discovered_path_count, '$.summary.discovered_path_count', errors, 0, 100_000);
    boundedInteger(summary.excluded_path_count, '$.summary.excluded_path_count', errors, 0, 100_000);
    boundedInteger(summary.candidate_document_count, '$.summary.candidate_document_count', errors, 0, 4096);
    boundedInteger(summary.document_count, '$.summary.document_count', errors, 0, 4096);
    boundedInteger(summary.omitted_document_count, '$.summary.omitted_document_count', errors, 0, 4096);
    boundedInteger(summary.total_source_bytes, '$.summary.total_source_bytes', errors, 0, 64 * 1024 * 1024);
    if (Array.isArray(catalog.documents) && summary.document_count !== catalog.documents.length) {
      errors.push('$.summary.document_count must equal $.documents.length');
    }
    if (
      Number.isSafeInteger(summary.candidate_document_count)
      && Number.isSafeInteger(summary.document_count)
      && Number.isSafeInteger(summary.omitted_document_count)
      && summary.candidate_document_count !== (summary.document_count as number) + (summary.omitted_document_count as number)
    ) {
      errors.push('$.summary.candidate_document_count must equal document_count plus omitted_document_count');
    }
    if (Number.isSafeInteger(summary.discovered_path_count) && Number.isSafeInteger(summary.candidate_document_count)
      && (summary.discovered_path_count as number) < (summary.candidate_document_count as number)) {
      errors.push('$.summary.discovered_path_count must be at least candidate_document_count');
    }
    if (Number.isSafeInteger(summary.total_source_bytes) && summary.total_source_bytes !== totalSourceBytes) {
      errors.push('$.summary.total_source_bytes must equal the sum of document size_bytes');
    }
  }
  return finish(errors);
}

export function validateDocumentSearchQuery(value: unknown): ValidationResult {
  const errors: string[] = [];
  const query = objectAt(value, '$', errors);
  if (!query) return finish(errors);
  rejectUnknown(query, ['schema_version', 'query', 'filters', 'limit'], '$', errors);
  required(query, ['schema_version', 'query'], '$', errors);
  if (query.schema_version !== '0.2') errors.push('$.schema_version must equal 0.2');
  validateSearchText(query.query, '$.query', errors);
  validateDocumentFilters(query.filters, '$.filters', errors, false);
  if (query.limit !== undefined) boundedInteger(query.limit, '$.limit', errors, 1, 50);
  return finish(errors);
}

interface ValidatedSearchHit {
  documentId?: string;
  path?: string;
  title?: string;
  authority?: string;
  sourceHash?: string;
  score?: number;
}

function validateSearchHit(value: unknown, path: string, errors: string[], resultTerms: readonly string[]): ValidatedSearchHit {
  const result: ValidatedSearchHit = {};
  const hit = objectAt(value, path, errors);
  if (!hit) return result;
  const keys = [
    'document_id', 'path', 'title', 'authority', 'source_hash', 'score',
    'matched_fields', 'matched_terms', 'excerpt',
  ];
  rejectUnknown(hit, keys, path, errors);
  required(hit, keys, path, errors);
  if (validateDocumentId(hit.document_id, `${path}.document_id`, errors)) result.documentId = hit.document_id;
  if (validateMarkdownPath(hit.path, `${path}.path`, errors)) result.path = hit.path;
  if (boundedString(hit.title, `${path}.title`, errors, 256)) {
    if (hit.title.trim().length === 0) errors.push(`${path}.title must contain non-whitespace text`);
    else result.title = hit.title;
  }
  if (typeof hit.authority !== 'string' || !DOCUMENT_AUTHORITY_SET.has(hit.authority)) {
    errors.push(`${path}.authority is invalid`);
  } else {
    result.authority = hit.authority;
  }
  if (validateDocumentHash(hit.source_hash, `${path}.source_hash`, errors)) result.sourceHash = hit.source_hash;
  if (boundedInteger(hit.score, `${path}.score`, errors, 0, Number.MAX_SAFE_INTEGER)) result.score = hit.score;
  documentStringArray(hit.matched_fields, `${path}.matched_fields`, errors, {
    minItems: 1, maxItems: documentMatchFields.length, maxLength: 32, allowed: DOCUMENT_MATCH_FIELD_SET,
  });
  const matchedTerms = documentStringArray(hit.matched_terms, `${path}.matched_terms`, errors, {
    minItems: 1, maxItems: 32, maxLength: MAX_NORMALIZED_DOCUMENT_TEXT,
  });
  if (matchedTerms && (matchedTerms.length !== resultTerms.length || matchedTerms.some((term, index) => term !== resultTerms[index]))) {
    errors.push(`${path}.matched_terms must equal the distinct normalized query terms under AND semantics`);
  }

  const excerptValue = objectAt(hit.excerpt, `${path}.excerpt`, errors);
  if (excerptValue) {
    rejectUnknown(excerptValue, ['text', 'start_line', 'end_line', 'truncated'], `${path}.excerpt`, errors);
    required(excerptValue, ['text', 'start_line', 'end_line', 'truncated'], `${path}.excerpt`, errors);
    if (boundedString(excerptValue.text, `${path}.excerpt.text`, errors, 400, true)
      && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(excerptValue.text)) {
      errors.push(`${path}.excerpt.text must not contain unsafe control characters`);
    }
    const startValid = boundedInteger(excerptValue.start_line, `${path}.excerpt.start_line`, errors, 1, Number.MAX_SAFE_INTEGER);
    const endValid = boundedInteger(excerptValue.end_line, `${path}.excerpt.end_line`, errors, 1, Number.MAX_SAFE_INTEGER);
    if (startValid && endValid) {
      if ((excerptValue.end_line as number) < (excerptValue.start_line as number)) errors.push(`${path}.excerpt.end_line must be >= start_line`);
      if ((excerptValue.end_line as number) - (excerptValue.start_line as number) >= 6) {
        errors.push(`${path}.excerpt must span at most six source lines`);
      }
    }
    if (typeof excerptValue.truncated !== 'boolean') errors.push(`${path}.excerpt.truncated must be a boolean`);
  }
  return result;
}

export function validateDocumentSearchResult(value: unknown): ValidationResult {
  const errors: string[] = [];
  const result = objectAt(value, '$', errors);
  if (!result) return finish(errors);
  const keys = [
    'schema_version', 'catalog_digest', 'query', 'terms', 'effective_filters',
    'hits', 'conflicts', 'summary',
  ];
  rejectUnknown(result, keys, '$', errors);
  required(result, keys, '$', errors);
  if (result.schema_version !== '0.2') errors.push('$.schema_version must equal 0.2');
  validateDocumentHash(result.catalog_digest, '$.catalog_digest', errors);
  const expectedTerms = validateSearchText(result.query, '$.query', errors);
  const terms = documentStringArray(result.terms, '$.terms', errors, {
    minItems: 1, maxItems: 32, maxLength: MAX_NORMALIZED_DOCUMENT_TEXT,
  });
  if (terms && (terms.length !== expectedTerms.length || terms.some((term, index) => term !== expectedTerms[index]))) {
    errors.push('$.terms must equal the distinct normalized query terms');
  }
  validateDocumentFilters(result.effective_filters, '$.effective_filters', errors, true);

  const validatedHits: ValidatedSearchHit[] = [];
  const hitIds = new Set<string>();
  const hitPaths = new Set<string>();
  if (!Array.isArray(result.hits)) {
    errors.push('$.hits must be an array');
  } else {
    if (result.hits.length > 50) errors.push('$.hits must contain at most 50 items');
    forEachDenseArray(result.hits, '$.hits', errors, (item, index) => {
      const hit = validateSearchHit(item, `$.hits[${index}]`, errors, expectedTerms);
      validatedHits.push(hit);
      if (hit.documentId) {
        if (hitIds.has(hit.documentId)) errors.push(`$.hits[${index}].document_id is duplicated`);
        hitIds.add(hit.documentId);
      }
      if (hit.path) {
        if (hitPaths.has(hit.path)) errors.push(`$.hits[${index}].path is duplicated`);
        hitPaths.add(hit.path);
      }
      const previous = validatedHits[index - 1];
      if (previous?.score !== undefined && hit.score !== undefined) {
        const previousAuthority = previous.authority ? documentAuthorities.indexOf(previous.authority as typeof documentAuthorities[number]) : -1;
        const authority = hit.authority ? documentAuthorities.indexOf(hit.authority as typeof documentAuthorities[number]) : -1;
        const outOfOrder = previous.score < hit.score
          || (previous.score === hit.score && previousAuthority > authority)
          || (previous.score === hit.score && previousAuthority === authority && (previous.path ?? '') > (hit.path ?? ''))
          || (previous.score === hit.score && previousAuthority === authority && previous.path === hit.path
            && (previous.documentId ?? '') > (hit.documentId ?? ''));
        if (outOfOrder) errors.push('$.hits must be ordered by score, authority, path, and id');
      }
    });
  }

  const expectedConflictGroups = new Map<string, ValidatedSearchHit[]>();
  for (const hit of validatedHits) {
    if (!hit.title || !hit.sourceHash || !hit.documentId) continue;
    const title = normalizeDocumentTitle(hit.title);
    const group = expectedConflictGroups.get(title) ?? [];
    group.push(hit);
    expectedConflictGroups.set(title, group);
  }
  const expectedConflicts = [...expectedConflictGroups.entries()]
    .filter(([, hits]) => hits.length >= 2 && new Set(hits.map((hit) => hit.sourceHash)).size >= 2)
    .map(([normalizedTitle, hits]) => ({
      normalized_title: normalizedTitle,
      document_ids: hits.map((hit) => hit.documentId as string).sort(),
    }))
    .sort((left, right) => left.normalized_title < right.normalized_title ? -1 : left.normalized_title > right.normalized_title ? 1 : 0);

  const actualConflicts: Array<{ normalized_title: string; document_ids: string[] }> = [];
  let validatedConflictIdCount = 0;
  if (!Array.isArray(result.conflicts)) {
    errors.push('$.conflicts must be an array');
  } else {
    if (result.conflicts.length > 4096) errors.push('$.conflicts must contain at most 4096 items');
    let previousTitle: string | undefined;
    const conflictIds = new Set<string>();
    forEachDenseArray(result.conflicts, '$.conflicts', errors, (item, index) => {
      const path = `$.conflicts[${index}]`;
      const conflict = objectAt(item, path, errors);
      if (!conflict) return;
      rejectUnknown(conflict, ['normalized_title', 'document_ids'], path, errors);
      required(conflict, ['normalized_title', 'document_ids'], path, errors);
      const titleValid = boundedString(
        conflict.normalized_title,
        `${path}.normalized_title`,
        errors,
        MAX_NORMALIZED_DOCUMENT_TEXT,
      );
      const ids = documentStringArray(conflict.document_ids, `${path}.document_ids`, errors, {
        minItems: 2, maxItems: 4096, maxLength: 68, sorted: true,
      });
      if (ids) {
        for (const id of ids) {
          validateDocumentId(id, `${path}.document_ids`, errors);
          if (conflictIds.has(id)) errors.push(`${path}.document_ids repeats an id from another conflict`);
          conflictIds.add(id);
        }
      }
      if (titleValid) {
        const title = conflict.normalized_title as string;
        if (normalizeDocumentTitle(title) !== title) errors.push(`${path}.normalized_title must be normalized`);
        if (previousTitle !== undefined && previousTitle >= title) errors.push('$.conflicts must be unique and sorted by normalized_title');
        previousTitle = title;
      }
      if (titleValid && ids) actualConflicts.push({ normalized_title: conflict.normalized_title as string, document_ids: ids });
    });
    validatedConflictIdCount = conflictIds.size;
  }
  for (const expected of expectedConflicts) {
    const actual = actualConflicts.find((conflict) => conflict.normalized_title === expected.normalized_title);
    if (!actual || expected.document_ids.some((id) => !actual.document_ids.includes(id))) {
      errors.push('$.conflicts must include every visible same-title group with different source hashes');
      break;
    }
  }

  const summary = objectAt(result.summary, '$.summary', errors);
  if (summary) {
    const summaryKeys = [
      'catalog_document_count', 'filtered_document_count', 'matched_document_count',
      'returned_hit_count', 'truncated',
    ];
    rejectUnknown(summary, summaryKeys, '$.summary', errors);
    required(summary, summaryKeys, '$.summary', errors);
    const catalogCountValid = boundedInteger(summary.catalog_document_count, '$.summary.catalog_document_count', errors, 0, 4096);
    const filteredCountValid = boundedInteger(summary.filtered_document_count, '$.summary.filtered_document_count', errors, 0, 4096);
    const matchedCountValid = boundedInteger(summary.matched_document_count, '$.summary.matched_document_count', errors, 0, 4096);
    const returnedCountValid = boundedInteger(summary.returned_hit_count, '$.summary.returned_hit_count', errors, 0, 50);
    if (typeof summary.truncated !== 'boolean') errors.push('$.summary.truncated must be a boolean');
    if (catalogCountValid && filteredCountValid && (summary.catalog_document_count as number) < (summary.filtered_document_count as number)) {
      errors.push('$.summary.catalog_document_count must be >= filtered_document_count');
    }
    if (catalogCountValid && validatedConflictIdCount > (summary.catalog_document_count as number)) {
      errors.push('$.conflicts cannot reference more unique documents than catalog_document_count');
    }
    if (filteredCountValid && matchedCountValid && (summary.filtered_document_count as number) < (summary.matched_document_count as number)) {
      errors.push('$.summary.filtered_document_count must be >= matched_document_count');
    }
    if (matchedCountValid && returnedCountValid && (summary.matched_document_count as number) < (summary.returned_hit_count as number)) {
      errors.push('$.summary.matched_document_count must be >= returned_hit_count');
    }
    if (Array.isArray(result.hits) && returnedCountValid && summary.returned_hit_count !== result.hits.length) {
      errors.push('$.summary.returned_hit_count must equal $.hits.length');
    }
    if (matchedCountValid && returnedCountValid && typeof summary.truncated === 'boolean'
      && summary.truncated !== ((summary.matched_document_count as number) > (summary.returned_hit_count as number))) {
      errors.push('$.summary.truncated must reflect omitted matched documents');
    }
  }
  return finish(errors);
}

import {
  ablationRequestSchema,
  ablationResultSchema,
  contextCandidateSchema,
  contextEnvelopeSchema,
  contextIntentSchema,
  contextPlanRequestSchema,
  contextSourceFailuresSchema,
  expansionDecisionSchema,
  expansionRequestSchema,
  outcomeReceiptSchema,
  outcomeDeclarationSchema,
  replayResultSchema,
  selectionReceiptSchema,
} from './context-schemas.js';
import type { ValidationResult } from './validator.js';

type JsonObject = Record<string, unknown>;
type Schema = Record<string, unknown>;

const MAX_INPUT_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_JSON_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_VALUES = 100_000;

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectJson(value: unknown, errors: string[], maxBytes: number): void {
  const ancestors = new Set<object>();
  let remaining = MAX_VALUES;
  const visit = (candidate: unknown, path: string, depth: number): void => {
    remaining -= 1;
    if (remaining < 0) {
      if (!errors.includes('$ exceeds the JSON value limit')) errors.push('$ exceeds the JSON value limit');
      return;
    }
    if (depth > MAX_DEPTH) {
      errors.push(`${path} exceeds the JSON depth limit`);
      return;
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) errors.push(`${path} must be a finite JSON number`);
      return;
    }
    if (typeof candidate !== 'object') {
      errors.push(`${path} is not a JSON value`);
      return;
    }
    if (ancestors.has(candidate)) {
      errors.push(`${path} must not be cyclic`);
      return;
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) errors.push(`${path} must be a plain JSON array`);
      for (let index = 0; index < candidate.length; index += 1) {
        if (!Object.hasOwn(candidate, index)) {
          errors.push(`${path}[${index}] must be present`);
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          errors.push(`${path}[${index}] must be an enumerable data item`);
          continue;
        }
        visit(descriptor.value, `${path}[${index}]`, depth + 1);
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) {
          errors.push(`${path} must not contain non-JSON array properties`);
        }
      }
    } else if (!isPlainObject(candidate)) {
      errors.push(`${path} must be a plain JSON object`);
    } else {
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== 'string') {
          errors.push(`${path} must not contain symbol properties`);
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          errors.push(`${path}.${key} must be an enumerable data property`);
          continue;
        }
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    }
    ancestors.delete(candidate);
  };
  visit(value, '$', 0);
  if (errors.length === 0) {
    const encoded = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (encoded > maxBytes) errors.push(`$ exceeds the ${maxBytes === MAX_INPUT_JSON_BYTES ? '1 MiB input' : '8 MiB artifact'} limit`);
  }
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === 'object') return isPlainObject(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return Number.isSafeInteger(value);
  return typeof value === expected;
}

function validateSchema(value: unknown, schemaValue: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(schemaValue)) return;
  const schema = schemaValue as Schema;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path} has an unsupported value`);
  if (typeof schema.type === 'string' && !typeMatches(value, schema.type)) {
    errors.push(`${path} must be ${schema.type === 'integer' ? 'a safe integer' : `a ${schema.type}`}`);
    return;
  }
  if (typeof value === 'string') {
    const codePoints = [...value].length;
    if (typeof schema.minLength === 'number' && codePoints < schema.minLength) errors.push(`${path} is too short`);
    if (typeof schema.maxLength === 'number' && codePoints > schema.maxLength) errors.push(`${path} is too long`);
    const maxUtf8Bytes = schema['x-primecontext-max-utf8-bytes'];
    if (typeof maxUtf8Bytes === 'number' && new TextEncoder().encode(value).byteLength > maxUtf8Bytes) {
      errors.push(`${path} exceeds ${maxUtf8Bytes} UTF-8 bytes`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path} has an invalid format`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} is below its minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} exceeds its maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.uniqueItems === true) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) errors.push(`${path} must contain unique items`);
    }
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, errors));
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
      } else {
        validateSchema(item, properties[key], `${path}.${key}`, errors);
      }
    }
  }
}

function validate(
  value: unknown,
  schema: unknown,
  cross?: (value: JsonObject, errors: string[]) => void,
  maxBytes = MAX_INPUT_JSON_BYTES,
): ValidationResult {
  const errors: string[] = [];
  inspectJson(value, errors, maxBytes);
  if (errors.length === 0) validateSchema(value, schema, '$', errors);
  if (errors.length === 0 && cross && isPlainObject(value)) cross(value, errors);
  return { valid: errors.length === 0, errors };
}

function ordinalSortedUnique(values: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(values)) return;
  const strings = values.filter((item): item is string => typeof item === 'string');
  const sorted = [...strings].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (strings.some((item, index) => item !== sorted[index])) errors.push(`${path} must be ordinally sorted`);
}

function validateTruncationMetadata(
  value: JsonObject,
  booleanField: 'truncated' | 'source_truncated',
  path: string,
  errors: string[],
): void {
  const reasons = value.truncation_reasons;
  ordinalSortedUnique(reasons, `${path}.truncation_reasons`, errors);
  if (Array.isArray(reasons) && reasons.length > 0 && value[booleanField] !== true) {
    errors.push(`${path}.${booleanField} must be true when truncation_reasons are present`);
  }
}

function validatePlanCross(value: JsonObject, errors: string[]): void {
  const task = value.task as JsonObject;
  const criteria = task.acceptance_criteria as JsonObject[];
  const ids = criteria.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length) errors.push('$.task.acceptance_criteria ids must be unique');
  ordinalSortedUnique(ids, '$.task.acceptance_criteria ids', errors);
  for (let index = 0; index < criteria.length; index += 1) {
    ordinalSortedUnique(criteria[index]?.required_terms, `$.task.acceptance_criteria[${index}].required_terms`, errors);
  }
  const hints = task.hints as JsonObject | undefined;
  if (hints) {
    ordinalSortedUnique(hints.paths, '$.task.hints.paths', errors);
    ordinalSortedUnique(hints.symbols, '$.task.hints.symbols', errors);
    ordinalSortedUnique(hints.terms, '$.task.hints.terms', errors);
  }
  ordinalSortedUnique(value.required_sources, '$.required_sources', errors);
  const totalRequiredTerms = criteria.reduce((count, criterion) => count + (Array.isArray(criterion.required_terms) ? criterion.required_terms.length : 0), 0);
  if (totalRequiredTerms > 64) errors.push('$.task.acceptance_criteria contains more than 64 required terms');
  const progressive = value.progressive_budget as JsonObject | undefined;
  if (progressive) {
    const initial = value.budget as JsonObject;
    const soft = progressive.soft as JsonObject;
    const hard = progressive.hard as JsonObject;
    for (const field of ['max_items', 'max_bytes', 'max_estimated_tokens']) {
      if (Number(initial[field]) > Number(soft[field])) errors.push(`$.budget.${field} must be <= $.progressive_budget.soft.${field}`);
      if (Number(soft[field]) > Number(hard[field])) errors.push(`$.progressive_budget.soft.${field} must be <= $.progressive_budget.hard.${field}`);
    }
  }
}

function validateCandidateCross(value: JsonObject, errors: string[]): void {
  const excerpt = String(value.excerpt);
  const bytes = new TextEncoder().encode(excerpt).byteLength;
  const lines = excerpt.split(/\r\n|\r|\n/u).length;
  if (lines > 400) errors.push('$.excerpt exceeds 400 source lines');
  if (value.excerpt_bytes !== bytes) errors.push('$.excerpt_bytes must equal the UTF-8 excerpt byte length');
  if (value.estimated_tokens !== Math.ceil(bytes / 4)) errors.push('$.estimated_tokens must equal ceil(excerpt_bytes / 4)');
  if (value.line_end !== undefined && value.line_start === undefined) errors.push('$.line_start is required when line_end is present');
  if (typeof value.line_start === 'number' && typeof value.line_end === 'number' && value.line_end < value.line_start) {
    errors.push('$.line_end must be >= line_start');
  }
  ordinalSortedUnique(value.authority_evidence, '$.authority_evidence', errors);
  const discovery = value.discovery as JsonObject;
  ordinalSortedUnique(discovery.matched_terms, '$.discovery.matched_terms', errors);
  ordinalSortedUnique(discovery.criteria_ids, '$.discovery.criteria_ids', errors);
  validateTruncationMetadata(discovery, 'truncated', '$.discovery', errors);
}

function validateEnvelopeCross(value: JsonObject, errors: string[]): void {
  const budgetValue = value.budget as JsonObject;
  const items = value.items as JsonObject[];
  const usedBytes = items.reduce((sum, item) => sum + Number(item.excerpt_bytes), 0);
  const usedTokens = items.reduce((sum, item) => sum + Number(item.estimated_tokens), 0);
  if (budgetValue.used_items !== items.length) errors.push('$.budget.used_items must equal items.length');
  if (budgetValue.used_bytes !== usedBytes) errors.push('$.budget.used_bytes must equal selected excerpt bytes');
  if (budgetValue.used_estimated_tokens !== usedTokens) errors.push('$.budget.used_estimated_tokens must equal selected estimated tokens');
  if (Number(budgetValue.used_items) > Number(budgetValue.max_items)
      || Number(budgetValue.used_bytes) > Number(budgetValue.max_bytes)
      || Number(budgetValue.used_estimated_tokens) > Number(budgetValue.max_estimated_tokens)) {
    errors.push('$.budget used values must not exceed maxima');
  }
  const itemIds = items.map((item) => item.id);
  if (new Set(itemIds).size !== itemIds.length) errors.push('$.items ids must be unique');
  const truncationValue = value.truncation as JsonObject;
  validateTruncationMetadata(truncationValue, 'source_truncated', '$.truncation', errors);
  if (truncationValue.selected_candidates !== items.length) errors.push('$.truncation.selected_candidates must equal items.length');
  if (Number(truncationValue.considered_candidates) !== Number(truncationValue.selected_candidates) + Number(truncationValue.omitted_candidates)) {
    errors.push('$.truncation counts must add up');
  }
  const aggregateReasons = new Set(Array.isArray(truncationValue.truncation_reasons)
    ? truncationValue.truncation_reasons as string[]
    : []);
  const selectedReasons = new Set(items.flatMap((item, index) => {
    const discovery = item.discovery as JsonObject;
    validateTruncationMetadata(discovery, 'truncated', `$.items[${index}].discovery`, errors);
    return Array.isArray(discovery.truncation_reasons) ? discovery.truncation_reasons as string[] : [];
  }));
  if (items.some((item) => (item.discovery as JsonObject).truncated === true)
      && truncationValue.source_truncated !== true) {
    errors.push('$.truncation.source_truncated must include truncated selected items');
  }
  if ([...selectedReasons].some((reason) => !aggregateReasons.has(reason))) {
    errors.push('$.truncation.truncation_reasons must include selected item reasons');
  }
  const coverage = value.criteria_coverage as JsonObject[];
  const coverageIds = coverage.map((criterion) => String(criterion.criterion_id));
  ordinalSortedUnique(coverageIds, '$.criteria_coverage criterion ids', errors);
  if (new Set(coverageIds).size !== coverageIds.length) errors.push('$.criteria_coverage criterion ids must be unique');
  const selectedIds = new Set(items.map((item) => String(item.id)));
  for (let index = 0; index < coverage.length; index += 1) {
    const criterion = coverage[index]!;
    const requiredTerms = criterion.required_terms as string[];
    const matchedTerms = criterion.matched_terms as string[];
    const candidateIds = criterion.candidate_ids as string[];
    ordinalSortedUnique(requiredTerms, `$.criteria_coverage[${index}].required_terms`, errors);
    ordinalSortedUnique(matchedTerms, `$.criteria_coverage[${index}].matched_terms`, errors);
    ordinalSortedUnique(candidateIds, `$.criteria_coverage[${index}].candidate_ids`, errors);
    if (matchedTerms.some((term) => !requiredTerms.includes(term))) {
      errors.push(`$.criteria_coverage[${index}].matched_terms must be a subset of required_terms`);
    }
    if (candidateIds.some((id) => !selectedIds.has(id))) {
      errors.push(`$.criteria_coverage[${index}].candidate_ids must reference selected items`);
    }
    if (criterion.match_mode === 'AT_LEAST' && !Number.isSafeInteger(criterion.minimum_matches)) {
      errors.push(`$.criteria_coverage[${index}].minimum_matches is required for AT_LEAST`);
    }
    if (criterion.match_mode !== 'AT_LEAST' && criterion.minimum_matches !== undefined) {
      errors.push(`$.criteria_coverage[${index}].minimum_matches is only allowed for AT_LEAST`);
    }
    const mechanicallyCovered = criterion.match_mode === 'AT_LEAST'
      ? matchedTerms.length >= Number(criterion.minimum_matches)
      : requiredTerms.length === 0
        ? candidateIds.length > 0
        : criterion.match_mode === 'ALL'
        ? requiredTerms.every((term) => matchedTerms.includes(term))
        : matchedTerms.length > 0;
    if (criterion.status === 'COVERED' && !mechanicallyCovered) {
      errors.push(`$.criteria_coverage[${index}].status cannot be COVERED without satisfying match_mode`);
    }
    if (criterion.status === 'MISSING' && mechanicallyCovered) {
      errors.push(`$.criteria_coverage[${index}].status cannot be MISSING when match_mode is satisfied`);
    }
  }
  const hasMissing = coverage.some((criterion) => criterion.status === 'MISSING');
  const hasConflicted = coverage.some((criterion) => criterion.status === 'CONFLICTED');
  const hasMissingLists = (value.missing_required_sources as unknown[]).length > 0 || (value.missing_required_terms as unknown[]).length > 0;
  const conflicts = value.conflicts as unknown[];
  if (value.evidence_status === 'READY' && (hasMissing || hasConflicted || hasMissingLists || conflicts.length > 0 || value.budget_status === 'EXHAUSTED')) {
    errors.push('$.evidence_status cannot be READY with missing, conflicted, or exhausted evidence');
  }
  if (value.evidence_status === 'CONFLICT' && conflicts.length === 0) errors.push('$.conflicts must be non-empty when evidence_status is CONFLICT');
  ordinalSortedUnique(value.missing_required_sources, '$.missing_required_sources', errors);
  ordinalSortedUnique(value.missing_required_terms, '$.missing_required_terms', errors);
}

function validateReceiptCross(value: JsonObject, errors: string[]): void {
  const decisions = value.decisions as JsonObject[];
  const ids = decisions.map((decision) => decision.candidate_id);
  if (new Set(ids).size !== ids.length) errors.push('$.decisions candidate ids must be unique');
  const truncationValue = value.truncation as JsonObject;
  validateTruncationMetadata(truncationValue, 'source_truncated', '$.truncation', errors);
  if (truncationValue.considered_candidates !== decisions.length) errors.push('$.truncation.considered_candidates must equal decisions.length');
  const selected = decisions.filter((decision) => decision.status === 'INCLUDED').length;
  const omitted = decisions.filter((decision) => decision.status === 'OMITTED').length;
  if (truncationValue.selected_candidates !== selected) errors.push('$.truncation.selected_candidates must equal included decisions');
  if (truncationValue.omitted_candidates !== omitted) errors.push('$.truncation.omitted_candidates must equal omitted decisions');
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index] as JsonObject;
    const components = decision.score_components as JsonObject;
    const total = Object.values(components).reduce<number>((sum, component) => sum + Number(component), 0);
    if (decision.score !== total) errors.push(`$.decisions[${index}].score must equal score_components total`);
    if (decision.status === 'INCLUDED' && !String(decision.reason).startsWith('INCLUDE_')) {
      errors.push(`$.decisions[${index}].reason must be an include reason when INCLUDED`);
    }
    if (decision.status === 'OMITTED' && !String(decision.reason).startsWith('OMIT_')) {
      errors.push(`$.decisions[${index}].reason must be an omit reason when OMITTED`);
    }
  }
  const byId = new Map(decisions.map((decision) => [String(decision.candidate_id), decision]));
  const duplicateIds = new Set<string>();
  const representativeIds = new Set<string>();
  for (const [index, groupValue] of (value.duplicate_groups as JsonObject[]).entries()) {
    const representative = String(groupValue.representative_id);
    const representativeDecision = byId.get(representative);
    if (representativeIds.has(representative)) {
      errors.push(`$.duplicate_groups[${index}].representative_id must be unique`);
    }
    representativeIds.add(representative);
    if (!representativeDecision || representativeDecision.status !== 'INCLUDED') {
      errors.push(`$.duplicate_groups[${index}].representative_id must reference an INCLUDED decision`);
    }
    for (const duplicate of groupValue.duplicate_ids as string[]) {
      if (duplicate === representative) {
        errors.push(`$.duplicate_groups[${index}].duplicate_ids must not contain its representative`);
      }
      if (duplicateIds.has(duplicate)) errors.push(`$.duplicate_groups[${index}].duplicate_ids must not overlap another group`);
      duplicateIds.add(duplicate);
      const decision = byId.get(duplicate);
      if (!decision || decision.status !== 'OMITTED' || decision.reason !== 'OMIT_DUPLICATE_CONTENT'
          || decision.duplicate_of !== representative) {
        errors.push(`$.duplicate_groups[${index}].duplicate_ids must link OMIT_DUPLICATE_CONTENT decisions`);
      }
    }
  }
  for (const representative of representativeIds) {
    if (duplicateIds.has(representative)) {
      errors.push('$.duplicate_groups representatives must not also be duplicate ids');
    }
  }
  for (const [index, decision] of decisions.entries()) {
    const candidateId = String(decision.candidate_id);
    const declaresDuplicate = decision.reason === 'OMIT_DUPLICATE_CONTENT' || decision.duplicate_of !== undefined;
    if (declaresDuplicate && !duplicateIds.has(candidateId)) {
      errors.push(`$.decisions[${index}] duplicate link must appear in exactly one duplicate group`);
    }
    if ((decision.reason === 'OMIT_DUPLICATE_CONTENT') !== (decision.duplicate_of !== undefined)) {
      errors.push(`$.decisions[${index}].reason and duplicate_of must describe the same duplicate link`);
    }
  }
}

function validateOutcomeCross(value: JsonObject, errors: string[]): void {
  const started = Date.parse(String(value.started_at));
  const recorded = Date.parse(String(value.recorded_at));
  if (!Number.isFinite(started) || !String(value.started_at).endsWith('Z')) errors.push('$.started_at must be a UTC date-time');
  if (!Number.isFinite(recorded) || !String(value.recorded_at).endsWith('Z')) errors.push('$.recorded_at must be a UTC date-time');
  if (Number.isFinite(started) && Number.isFinite(recorded) && recorded < started) errors.push('$.recorded_at must not precede started_at');
  if (Array.isArray(value.estimated_fields)) {
    const metrics = value.metrics as JsonObject;
    for (const field of value.estimated_fields) {
      if (typeof field === 'string' && !Object.hasOwn(metrics, field)) errors.push(`$.metrics.${field} is required when estimated`);
    }
  }
}

function validateReplayCross(value: JsonObject, errors: string[]): void {
  if (value.status === 'IDENTICAL') {
    if (value.new_selection_digest !== value.old_selection_digest) errors.push('$.new_selection_digest must equal old_selection_digest when IDENTICAL');
    if (value.freshness !== 'MATCHED') errors.push('$.freshness must be MATCHED when IDENTICAL');
  } else if (value.status === 'DRIFTED') {
    if (typeof value.new_selection_digest !== 'string' || value.new_selection_digest === value.old_selection_digest) {
      errors.push('$.new_selection_digest must differ from old_selection_digest when DRIFTED');
    }
    if (value.freshness === 'UNAVAILABLE') errors.push('$.freshness cannot be UNAVAILABLE when DRIFTED');
  } else if (value.status === 'UNREPLAYABLE') {
    if (value.new_selection_digest !== undefined || value.new_snapshot !== undefined) errors.push('$ must not include new replay state when UNREPLAYABLE');
    if (value.freshness !== 'UNAVAILABLE') errors.push('$.freshness must be UNAVAILABLE when UNREPLAYABLE');
  }
}

function validateAblationCross(value: JsonObject, errors: string[]): void {
  if (value.decision === 'DERIVED') {
    if (typeof value.ablated_selection_digest !== 'string') errors.push('$.ablated_selection_digest is required when DERIVED');
    if (value.reason !== 'NON_MANDATORY_REMOVED') errors.push('$.reason must be NON_MANDATORY_REMOVED when DERIVED');
  } else if (value.decision === 'DENIED') {
    if (value.ablated_selection_digest !== undefined) errors.push('$.ablated_selection_digest is not allowed when DENIED');
    if (value.reason === 'NON_MANDATORY_REMOVED') errors.push('$.reason must explain why ablation was denied');
  }
  if (value.decision === 'DERIVED' && value.evidence_status === 'READY') {
    if ((value.missing_criteria_ids as unknown[]).length > 0 || (value.missing_required_terms as unknown[]).length > 0
        || (Array.isArray(value.missing_required_sources) && value.missing_required_sources.length > 0)
        || (Array.isArray(value.source_failures) && value.source_failures.length > 0)
        || (Array.isArray(value.conflicts) && value.conflicts.length > 0)
        || (value.budget_status !== undefined && value.budget_status !== 'WITHIN_BUDGET')) {
      errors.push('$.evidence_status cannot be READY while another insufficiency remains');
    }
  }
}

function validateExpansionDecisionCross(value: JsonObject, errors: string[]): void {
  const reasons = value.reason_codes as string[];
  const additions = value.additions as string[];
  const staleOrDuplicate = reasons.includes('STALE_PARENT') || reasons.includes('DUPLICATE_ONLY');
  if (staleOrDuplicate && (value.status !== 'DENIED' || additions.length > 0)) {
    errors.push('$ stale or duplicate-only expansion decisions must be DENIED without additions');
  }
  if (reasons.includes('EVIDENCE_ADDED') !== (additions.length > 0)) {
    errors.push('$.reason_codes EVIDENCE_ADDED must correspond to non-empty additions');
  }
  if (reasons.includes('NO_NEW_EVIDENCE') && additions.length > 0) {
    errors.push('$.reason_codes NO_NEW_EVIDENCE is incompatible with additions');
  }
}

export const validateContextPlanRequest = (value: unknown): ValidationResult => validate(value, contextPlanRequestSchema, validatePlanCross);
export const validateContextIntent = (value: unknown): ValidationResult => validate(value, contextIntentSchema);
export const validateContextCandidate = (value: unknown): ValidationResult => validate(value, contextCandidateSchema, validateCandidateCross);
export const validateContextEnvelope = (value: unknown): ValidationResult => validate(value, contextEnvelopeSchema, validateEnvelopeCross, MAX_ARTIFACT_JSON_BYTES);
export const validateSelectionReceipt = (value: unknown): ValidationResult => validate(value, selectionReceiptSchema, validateReceiptCross, MAX_ARTIFACT_JSON_BYTES);
export const validateContextSourceFailures = (value: unknown): ValidationResult => validate(value, contextSourceFailuresSchema);
export const validateExpansionRequest = (value: unknown): ValidationResult => validate(value, expansionRequestSchema);
export const validateExpansionDecision = (value: unknown): ValidationResult => validate(value, expansionDecisionSchema, validateExpansionDecisionCross, MAX_ARTIFACT_JSON_BYTES);
export const validateContextOutcomeInput = (value: unknown): ValidationResult => validate(value, outcomeDeclarationSchema, validateOutcomeCross);
export const validateOutcomeReceipt = (value: unknown): ValidationResult => validate(value, outcomeReceiptSchema, validateOutcomeCross, MAX_ARTIFACT_JSON_BYTES);
export const validateAblationRequest = (value: unknown): ValidationResult => validate(value, ablationRequestSchema);
export const validateAblationResult = (value: unknown): ValidationResult => validate(value, ablationResultSchema, validateAblationCross, MAX_ARTIFACT_JSON_BYTES);
export const validateReplayResult = (value: unknown): ValidationResult => validate(value, replayResultSchema, validateReplayCross, MAX_ARTIFACT_JSON_BYTES);

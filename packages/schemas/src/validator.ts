import { metricNumericFields, taskTypes } from './schemas.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type Obj = Record<string, unknown>;

function objectAt(value: unknown, path: string, errors: string[]): Obj | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  return value as Obj;
}

function required(obj: Obj, keys: readonly string[], path: string, errors: string[]): void {
  for (const key of keys) if (!(key in obj)) errors.push(`${path}.${key} is required`);
}

function stringField(obj: Obj, key: string, path: string, errors: string[], requiredField = false): void {
  const value = obj[key];
  if (value === undefined && !requiredField) return;
  if (typeof value !== 'string' || value.length === 0) errors.push(`${path}.${key} must be a non-empty string`);
}

function stringArray(value: unknown, path: string, errors: string[], minItems = 0): void {
  if (!Array.isArray(value)) { errors.push(`${path} must be an array`); return; }
  if (value.length < minItems) errors.push(`${path} must contain at least ${minItems} item(s)`);
  value.forEach((item, i) => { if (typeof item !== 'string' || item.length === 0) errors.push(`${path}[${i}] must be a non-empty string`); });
}

function nonNegativeInt(value: unknown, path: string, errors: string[], positive = false): void {
  if (!Number.isInteger(value) || (value as number) < (positive ? 1 : 0)) errors.push(`${path} must be ${positive ? 'a positive' : 'a non-negative'} integer`);
}

function rejectUnknown(obj: Obj, allowed: readonly string[], path: string, errors: string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(obj)) if (!set.has(key)) errors.push(`${path}.${key} is not allowed`);
}

function finish(errors: string[]): ValidationResult { return { valid: errors.length === 0, errors }; }

export function validateContextBudget(value: unknown): ValidationResult {
  const errors: string[] = [];
  const obj = objectAt(value, '$.context_budget', errors);
  if (!obj) return finish(errors);
  required(obj, ['initial_tokens', 'soft_limit_tokens', 'hard_limit_tokens'], '$.context_budget', errors);
  rejectUnknown(obj, ['initial_tokens', 'soft_limit_tokens', 'hard_limit_tokens'], '$.context_budget', errors);
  for (const key of ['initial_tokens', 'soft_limit_tokens', 'hard_limit_tokens'] as const) nonNegativeInt(obj[key], `$.context_budget.${key}`, errors, true);
  if (errors.length === 0) {
    const initial = obj.initial_tokens as number, soft = obj.soft_limit_tokens as number, hard = obj.hard_limit_tokens as number;
    if (initial > soft) errors.push('$.context_budget initial_tokens must be <= soft_limit_tokens');
    if (soft > hard) errors.push('$.context_budget soft_limit_tokens must be <= hard_limit_tokens');
  }
  return finish(errors);
}

export function validateTaskCapsule(value: unknown): ValidationResult {
  const errors: string[] = [];
  const obj = objectAt(value, '$', errors); if (!obj) return finish(errors);
  const allowed = ['schema_version','task_id','goal','task_type','module','priority','boundaries','decisions','contracts','documents','code_targets','acceptance','context_budget','worktree','metadata'];
  rejectUnknown(obj, allowed, '$', errors);
  required(obj, ['schema_version','task_id','goal','task_type','boundaries','acceptance','context_budget'], '$', errors);
  if (obj.schema_version !== '0.1') errors.push('$.schema_version must equal 0.1');
  stringField(obj, 'task_id', '$', errors, true); stringField(obj, 'goal', '$', errors, true);
  if (!(taskTypes as readonly unknown[]).includes(obj.task_type)) errors.push('$.task_type is invalid');
  stringField(obj, 'module', '$', errors); stringField(obj, 'priority', '$', errors);
  const boundaries = objectAt(obj.boundaries, '$.boundaries', errors);
  if (boundaries) {
    rejectUnknown(boundaries, ['allowed_paths','forbidden_paths'], '$.boundaries', errors);
    required(boundaries, ['allowed_paths','forbidden_paths'], '$.boundaries', errors);
    stringArray(boundaries.allowed_paths, '$.boundaries.allowed_paths', errors);
    stringArray(boundaries.forbidden_paths, '$.boundaries.forbidden_paths', errors);
  }
  if (obj.decisions !== undefined) {
    if (!Array.isArray(obj.decisions)) errors.push('$.decisions must be an array');
    else obj.decisions.forEach((decision, i) => {
      const d = objectAt(decision, `$.decisions[${i}]`, errors); if (!d) return;
      rejectUnknown(d, ['source','summary'], `$.decisions[${i}]`, errors); required(d, ['source','summary'], `$.decisions[${i}]`, errors);
      stringField(d, 'source', `$.decisions[${i}]`, errors, true); stringField(d, 'summary', `$.decisions[${i}]`, errors, true);
    });
  }
  for (const key of ['contracts','documents','code_targets'] as const) if (obj[key] !== undefined) stringArray(obj[key], `$.${key}`, errors);
  stringArray(obj.acceptance, '$.acceptance', errors, 1);
  errors.push(...validateContextBudget(obj.context_budget).errors);
  if (obj.worktree !== undefined) {
    const w = objectAt(obj.worktree, '$.worktree', errors); if (w) {
      rejectUnknown(w, ['root','branch','head'], '$.worktree', errors); required(w, ['root'], '$.worktree', errors);
      stringField(w, 'root', '$.worktree', errors, true); stringField(w, 'branch', '$.worktree', errors); stringField(w, 'head', '$.worktree', errors);
    }
  }
  if (obj.metadata !== undefined) objectAt(obj.metadata, '$.metadata', errors);
  return finish(errors);
}

export function validateCompactHandoff(value: unknown): ValidationResult {
  const errors: string[] = []; const obj = objectAt(value, '$', errors); if (!obj) return finish(errors);
  const allowed = ['schema_version','task_id','status','commit','changed_files','interfaces_added','decisions','tests','risks','next_unblocked','artifacts','metrics_ref'];
  rejectUnknown(obj, allowed, '$', errors); required(obj, ['schema_version','task_id','status','changed_files','tests','risks','next_unblocked'], '$', errors);
  if (obj.schema_version !== '0.1') errors.push('$.schema_version must equal 0.1'); stringField(obj,'task_id','$',errors,true);
  if (!['PASS','FAIL','PARTIAL','BLOCKED'].includes(obj.status as string)) errors.push('$.status is invalid'); stringField(obj,'commit','$',errors);
  for (const key of ['changed_files','interfaces_added','decisions','risks','next_unblocked','artifacts'] as const) if (obj[key] !== undefined) stringArray(obj[key], `$.${key}`, errors);
  stringField(obj,'metrics_ref','$',errors);
  const tests = objectAt(obj.tests, '$.tests', errors); if (tests) {
    rejectUnknown(tests,['passed','failed','skipped'],'$.tests',errors); required(tests,['passed','failed'],'$.tests',errors);
    nonNegativeInt(tests.passed,'$.tests.passed',errors); nonNegativeInt(tests.failed,'$.tests.failed',errors); if (tests.skipped !== undefined) nonNegativeInt(tests.skipped,'$.tests.skipped',errors);
  }
  return finish(errors);
}

export function validateRepoMap(value: unknown): ValidationResult {
  const errors: string[] = []; const obj = objectAt(value, '$', errors); if (!obj) return finish(errors);
  rejectUnknown(obj,['schema_version','generated_at','repository','modules','summary'],'$',errors); required(obj,['schema_version','generated_at','repository','modules','summary'],'$',errors);
  if (obj.schema_version !== '0.1') errors.push('$.schema_version must equal 0.1'); stringField(obj,'generated_at','$',errors,true);
  const repo = objectAt(obj.repository,'$.repository',errors); if (repo) {
    rejectUnknown(repo,['root','name','branch','head'],'$.repository',errors); required(repo,['root','name'],'$.repository',errors);
    stringField(repo,'root','$.repository',errors,true); stringField(repo,'name','$.repository',errors,true); stringField(repo,'branch','$.repository',errors); stringField(repo,'head','$.repository',errors);
  }
  if (!Array.isArray(obj.modules)) errors.push('$.modules must be an array'); else obj.modules.forEach((module,i)=>{
    const m=objectAt(module,`$.modules[${i}]`,errors); if(!m)return; rejectUnknown(m,['id','path','kind','role','evidence'],`$.modules[${i}]`,errors); required(m,['id','path','kind','role','evidence'],`$.modules[${i}]`,errors);
    stringField(m,'id',`$.modules[${i}]`,errors,true); stringField(m,'path',`$.modules[${i}]`,errors,true); stringField(m,'role',`$.modules[${i}]`,errors,true);
    if(!['workspace_package','source','tests','documentation','configuration','examples','benchmarks','other'].includes(m.kind as string)) errors.push(`$.modules[${i}].kind is invalid`); stringArray(m.evidence,`$.modules[${i}].evidence`,errors);
  });
  const summary=objectAt(obj.summary,'$.summary',errors); if(summary){rejectUnknown(summary,['module_count','discovered_path_count','excluded_path_count'],'$.summary',errors); required(summary,['module_count','discovered_path_count','excluded_path_count'],'$.summary',errors); for(const key of ['module_count','discovered_path_count','excluded_path_count'] as const) nonNegativeInt(summary[key],`$.summary.${key}`,errors);}
  return finish(errors);
}

export function validateMetricRecord(value: unknown): ValidationResult {
  const errors: string[]=[]; const obj=objectAt(value,'$',errors); if(!obj)return finish(errors);
  const allowed=['schema_version','task_id','recorded_at','arm',...metricNumericFields,'test_status','review_status','estimated_fields'];
  rejectUnknown(obj,allowed,'$',errors); required(obj,['schema_version','task_id','recorded_at'],'$',errors); if(obj.schema_version!=='0.1')errors.push('$.schema_version must equal 0.1'); stringField(obj,'task_id','$',errors,true); stringField(obj,'recorded_at','$',errors,true);
  if(obj.arm!==undefined && !['A','B'].includes(obj.arm as string))errors.push('$.arm is invalid');
  for(const key of metricNumericFields) if(obj[key]!==undefined) nonNegativeInt(obj[key],`$.${key}`,errors);
  if(obj.test_status!==undefined && !['PASS','FAIL','UNKNOWN'].includes(obj.test_status as string))errors.push('$.test_status is invalid'); if(obj.review_status!==undefined && !['PASS','FAIL','UNKNOWN'].includes(obj.review_status as string))errors.push('$.review_status is invalid');
  if(obj.estimated_fields!==undefined){if(!Array.isArray(obj.estimated_fields))errors.push('$.estimated_fields must be an array');else{const seen=new Set<string>(); obj.estimated_fields.forEach((field,i)=>{if(!(metricNumericFields as readonly unknown[]).includes(field))errors.push(`$.estimated_fields[${i}] is invalid`); if(typeof field==='string'){if(seen.has(field))errors.push(`$.estimated_fields contains duplicate ${field}`); seen.add(field);}});}}
  return finish(errors);
}

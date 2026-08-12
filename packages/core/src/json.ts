export function cloneValidatedJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Validated JSON value could not be serialized');
  return JSON.parse(serialized) as T;
}

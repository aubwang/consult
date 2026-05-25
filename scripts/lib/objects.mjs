export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function omitUndefined(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

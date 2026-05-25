export function safeSegment(value, { maxLength = 40 } = {}) {
  return String(value ?? "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, maxLength) || "unknown";
}

export interface SafeSegmentOptions {
  maxLength?: number;
}

export function safeSegment(value: unknown, { maxLength = 40 }: SafeSegmentOptions = {}): string {
  return String(value ?? "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, maxLength) || "unknown";
}

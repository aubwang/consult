export const DEFAULT_MAX_FINAL_TEXT_CHARS = 1024 * 1024;
export const TEXT_TRUNCATED_MARKER = "\n[consult: final text truncated]\n";

export function appendBoundedText(
  current,
  addition,
  { maxChars = DEFAULT_MAX_FINAL_TEXT_CHARS, marker = TEXT_TRUNCATED_MARKER } = {},
) {
  if (!addition || maxChars <= 0) {
    return current;
  }
  const combined = `${current}${addition}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  if (maxChars <= marker.length) {
    return marker.slice(0, maxChars);
  }
  return `${combined.slice(0, maxChars - marker.length)}${marker}`;
}

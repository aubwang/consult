export function briefText(text: string): string {
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (!compact) {
    return "-";
  }
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

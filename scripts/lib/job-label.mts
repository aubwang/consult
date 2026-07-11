export const JOB_LABEL_MAX_LENGTH = 80;
export const JOB_LABEL_ERROR =
  `--label must be 1-${JOB_LABEL_MAX_LENGTH} characters without control characters`;

export function normalizeJobLabel(value: string | undefined):
  | { ok: true; label: string | undefined }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true, label: undefined };
  const label = value.trim();
  if (
    label.length === 0 ||
    label.length > JOB_LABEL_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    return { ok: false, error: JOB_LABEL_ERROR };
  }
  return { ok: true, label };
}

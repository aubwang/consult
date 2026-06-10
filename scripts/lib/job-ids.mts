import crypto from "node:crypto";

export function defaultGenerateJobId(): string {
  return `job-${crypto.randomBytes(9).toString("base64url").slice(0, 12)}`;
}

import crypto from "node:crypto";

export function defaultGenerateJobId() {
  return `job-${crypto.randomBytes(9).toString("base64url").slice(0, 12)}`;
}

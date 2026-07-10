import type { JobAuthorityDiagnostic } from "../job-authority.mts";
import type { OutputHandle } from "./output.mts";

export function writeAuthorityDiagnostic(
  output: Pick<OutputHandle, "stderr">,
  diagnostic: JobAuthorityDiagnostic,
  json: boolean,
): void {
  if (json) {
    output.stderr(`${JSON.stringify({ schemaVersion: 1, error: diagnostic })}\n`);
    return;
  }
  output.stderr(
    `${diagnostic.code}: ${diagnostic.message}\nRemediation: ${diagnostic.remediation}\n`,
  );
}

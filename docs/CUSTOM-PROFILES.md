# Custom ACP Profiles

A custom Profile points Consult at an executable that speaks ACP on stdin and stdout. It requires explicit `--sandbox inherit`; custom executables do not acquire the built-in Codex or Claude confinement policy by choosing a display name.

Global configuration lives at `~/.consult/profiles.json`, or at `profiles.json` under `CONSULT_DATA_DIR`. Merge a custom entry into the existing file without replacing other Profiles or defaults:

```json
{
  "schemaVersion": 1,
  "default": "my-agent",
  "hostDefaults": {},
  "profiles": {
    "my-agent": {
      "registryId": "my-acp-agent",
      "binary": "/absolute/path/to/my-acp-agent",
      "args": ["--acp"],
      "env": {},
      "installedAt": "2026-09-09T00:00:00.000Z",
      "installedVia": "manual"
    }
  }
}
```

Use the arguments required by your agent. The example executable is a placeholder, not a package recommendation. Prefer absolute executable and file-argument paths so initialization does not depend on the working directory. Keep secrets out of `args` and `env` in this file; inherited Profiles can consume vendor credential variables from the invoking environment or use their native login mechanism.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1` |
| `default` | A configured Profile key, or `null` |
| `hostDefaults` | Optional mapping from Host names to configured Profile keys |
| `profiles` | Mapping from user-facing Profile keys to launch records |
| `registryId` | Implementation identity; use your own identity for a custom agent |
| `binary` | Executable path or command name |
| `args` | Array of argument strings |
| `env` | Object of non-secret string environment overrides |
| `installedAt` | Installation timestamp string |
| `installedVia`, `lastVerifiedAt` | Optional installation and verification metadata |
| `codexPath`, `codexVersion` | Optional built-in Codex routing metadata; omit for custom agents |

```sh
consult agents --json
consult doctor --agent my-agent --sandbox inherit
consult delegate --agent my-agent --sandbox inherit --read-only -- \
  "Inspect the repository layout. Return a short description; do not edit."
```

A passing initialization check does not establish full conformance. Test the agent's permission requests, stop reasons, cancellation, and advertised session reopening before relying on it. It must offer `allow_once` for requests Consult approves; unknown operation kinds and requests from an unrecognized Session are denied. General shell execution remains unavailable through Consult's permission policy.

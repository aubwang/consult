# Capabilities as the Host probe surface

Status: Accepted

`consult capabilities [--json]` is the supported way for a Host to learn what a
Consult build can do. It reports the CLI version, the schema version of every
machine-readable contract, which optional commands exist, and the bounds those
commands enforce.

```jsonc
{
  "schemaVersion": 1,
  "version": "1.2.0",
  "contracts": { "jobResult": 1, "events": 1, "profiles": 1 },
  "features": {
    "report": true,
    "events": true,
    "steer": true,
    "nativeReviewProfiles": ["codex"]
  },
  "bounds": {
    "reportMessageBytes": 4096,
    "reportDataBytes": 16384,
    "reportsPerJob": 256,
    "steerGuidanceBytes": 16384
  }
}
```

## Why

`report`, `events` (ADR-0039), and `steer` (ADR-0040) are additive commands, so
a Host that integrates Consult has to ask whether the installed build has them.
Until now the only way to ask was to run the command and read the exit code,
which is a bad probe twice over: exit 2 means both "no such subcommand" and
"you passed a bad argument", and `consult --version` could not break the tie
because feature builds and the released 1.0.0 both self-reported `1.0.0`.

A Host that guesses wrong here does not fail loudly. It either withholds a
feature the build has, or sends a payload the build silently cannot act on.
Version-range sniffing would work once versions are trustworthy, but it makes
every Host encode a table of which version gained which feature. Declaring the
answer directly is smaller for the Host and cheaper for us to keep honest.

`bounds` is in the report for the same reason: a Host that batches interim
reports or composes steering guidance needs the limit *before* it sends, and
the alternative is duplicating our constants in every integration.

## Static self-description

Capabilities reads no Workspace, no Job state, and no configured Profiles. Like
`help` and `version`, it answers identically from anywhere on the filesystem,
including outside a Git repository — which matters because a Host commonly
probes at startup, before it knows which directory the user will work in. The
one file it reads is the shipped Profile registry, to report which Profiles
advertise a native review command.

Every number and flag is taken from the constant the behavior is bounded by
(`MAX_REPORT_MESSAGE_BYTES`, `EVENTS_SCHEMA_VERSION`, and so on), never
restated. A report that can drift from the behavior it describes is worse than
no report, because a Host would trust it.

## Consequences

- Hosts branch on `schemaVersion` and ignore unknown fields, as with every other
  Consult envelope (ADR-0023). New contracts, features, and bounds are added to
  the existing sections; removing or renaming one needs a new schema version.
- `features` says a command exists in this build. It does not promise the
  command will succeed for a given Job: `steer` still refuses an unsteerable
  Profile or an isolated Job at call time, and `report` still requires an
  inherit-sandbox Job. Capability is a build property; eligibility is a Job
  property, and they are answered by different surfaces.
- **Fallback for older builds:** a build before 1.2.0 has no `capabilities`
  command and exits 2 with `unknown subcommand: capabilities`. That is the
  documented signal to treat `report`, `events`, and `steer` as unavailable. It
  is the only exit-code probe a Host should perform, and it is needed exactly
  once — for builds that shipped before this contract existed.
- The command is public and carries its own usage, so `consult help
  capabilities` answers without a Host having to know this ADR exists.

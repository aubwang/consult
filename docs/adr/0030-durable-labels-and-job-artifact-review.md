# ADR 0030: Durable labels and Job Artifact Review

## Status

Accepted.

## Decision

Delegate and review Jobs may carry an optional trimmed Job Label of at most 80
characters. Labels are non-unique display metadata; Job ids remain the only
identifiers used by commands, dependencies, lineage, and authorization.

`review --job <job-id>` creates a read-only review Job from a completed isolated
write Job. Consult supplies the source task, final report, touched-files list,
and isolated patch as bounded untrusted input. The review records
`reviewOfJobId` but does not apply the patch or create dependency, lineage,
cancellation, authority, or Session relationships.

The source patch path must exactly match Consult-owned isolated Job state and
is opened without following symlinks.

## Rationale

Labels let an agent Host recover intent after compaction without inventing a
second identity system. Job Artifact Review lets a second Profile inspect an
implementation without forcing the Host to load the patch into its own context
or mutate the original checkout.

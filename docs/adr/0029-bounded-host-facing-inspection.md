# ADR 0029: Bound Host-facing Job inspection by default

## Status

Accepted.

## Decision

Consult keeps Job inspection surfaces distinct and bounded:

- `status` lists the newest 20 Jobs unless `--all` is explicit;
- `status <id>` returns a concise Job summary and never embeds logs;
- `logs <id>` returns the latest 20 rendered lines unless `--tail <n>` or
  `--all` is explicit;
- `logs --follow` seeds the same bounded history and then streams new updates;
- `wait --summary` blocks normally but returns bounded one-line outcomes and
  artifact paths;
- `result` remains the final Profile-answer surface.

The equivalent JSON commands follow the same bounds, and status JSON does not
embed log records.

## Rationale

Consult is commonly operated by an LLM Host. Repeated status checks and raw log
tails can consume that Host's context with tool updates and file contents that
do not help it decide what to do next. Small defaults make the routine path
predictable while explicit flags preserve diagnostics and automation.

`completed` remains a transport-level Job state. The Host must inspect the
result to decide whether the delegated task succeeded semantically.

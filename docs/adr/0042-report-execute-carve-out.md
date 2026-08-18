# A narrow execute carve-out for interim reports

Status: Accepted

The permission layer approves exactly one execute request without an execute
grant: an inherit-authority Job invoking this installation's own `consult`
binary to run `report` on itself. Every other execute stays denied with the
diagnostics it had before.

## Why

ADR-0039 gave a running Job a way to say it is blocked. Live testing then showed
no real Profile could use it. `consult report` is a shell command, real Profiles
ask for permission before running a shell command, and `decidePermission` denied
every execute unconditionally — so a real Codex Job asked, was refused, and gave
up. The feature worked only for the fake test agent, which never asked because
it never had a shell tool at all.

Granting `--allow-exec` instead is not an option and would not be one: it
authorizes arbitrary commands, and it is deliberately unavailable while
execute-specific resource containment is incomplete. The Job does not need to
run commands. It needs to run *one* command, whose entire effect is appending a
bounded line to its own log — something Consult already lets it do, and would do
itself if there were a channel to ask over.

## Threat model

This is a cooperative layer, not an OS boundary, and it is honest about which.
An inherit-sandbox Job already runs with the Host's full ambient authority: it
can run anything it likes without asking, because nothing stops it. The
permission answer is advice a well-behaved Profile follows.

So the carve-out does not *contain* a hostile Profile — nothing here does. What
it does is keep the advice least-privilege for the well-behaved majority: a
Profile that routes its shell tool through permission requests gets exactly the
one command the product needs it to run, and a rejection for everything else.
That matters because Profiles are also the vehicle for prompt injection. A
delegate persuaded by hostile file content to run `curl | sh` still gets a
refusal, and a Profile that honors refusals still stops.

Confined Jobs keep unconditional denial. They have no `consult` on their PATH
and cannot execute anything anyway, so a carve-out there would widen the stated
authority model in exchange for nothing.

## The predicate

An execute request is approved only when **all** of the following hold.

1. **Confinement is `inherit`.** The default when a caller does not say is
   `confined`, so the carve-out is opt-in at the call site and absent from every
   path that has not been updated.
2. **The command is one simple invocation.** `rawInput.command` is either an
   argv array or a command string.
   - A **string** is read by a shell, so it is tokenized under shell rules and
     denied on anything that could mean more than one command: `&& || ; | & < >`,
     backticks, `$(…)`, `$VAR` and `\` inside double quotes, newlines, unclosed
     quotes, glob and brace characters, or any other metacharacter outside
     quotes. Single-quoted runs are safe verbatim; that is how a message
     containing punctuation gets through.
   - An **array** is the argv itself. Its elements are literal arguments that no
     shell reads again, so a message element may contain anything. This is the
     one assumption the design rests on: a Profile that joined an argv array
     back into a shell string would break this, and would also break every
     ordinary command it runs.
   - `bash -lc "<script>"` is unwrapped exactly once, only in the three-token
     form with `-c`, `-lc`, or `-cl`, and only when the script inside is itself
     one simple invocation that is not another shell. Several Profiles wrap
     every shell tool call this way, so refusing it outright would refuse the
     feature.
   - An environment-prefixed command (`FOO=1 consult report …`) is denied, as is
     a `rawInput.env` or escalation field. `CONSULT_PARENT_JOB` is what decides
     which Job a report belongs to, so anything able to set it is anything able
     to forge attribution.
3. **The binary is this installation.** The invoked file is resolved — against
   the working directory when it carries a path separator, through `PATH`
   otherwise — and then `realpath`ed and compared to the `realpath` of the
   `bin/consult` belonging to the running companion. Identity, not spelling: a
   workspace-local `./consult` imposter fails, the symlink an npm global install
   puts on `PATH` passes, and a *second, different* consult installation also
   fails, because this Job's reports belong to this Job's state directory.
4. **The argv is `report` plus report data.** After the binary: the literal
   `report`, then only `--type`, `--message`, and `--data` (in either `--flag
   value` or `--flag=value` form), then optionally `--` after which everything
   is the message. Unknown flags and stray positionals deny.
   The flag walk mirrors `parseArgs` exactly — a following token is a value only
   when it is not itself a flag — because a validator that disagreed with the
   real parser would be an escape. `consult report --type --job other` is
   precisely that case: the validator must see `--job` as a flag, as consult
   does, and deny.
5. **Everything else about execute is unchanged**, including cwd confinement,
   which still applies first and still denies with the same message.

`--job` is excluded from (4) deliberately. A Job may only report as itself; that
is what `CONSULT_PARENT_JOB` already says, and accepting `--job` would let one
Job write into another Job's event stream. It is the single most valuable flag
to an attacker and the least valuable to an honest delegate, which never needs
it.

Every uncertainty denies. The tokenizer understands a deliberately small subset
of shell syntax and refuses everything outside it, because approving a construct
it does not model would mean approving whatever that construct actually does.

## Consequences

- A delegated inherit-sandbox Job can call `consult report` without an execute
  grant and without a Host approval prompt. Confined Jobs cannot, and neither
  can any Job reach any other command this way.
- `consult capabilities --json` reports `features.reportExec`, so a Host can
  tell a build that will approve the call from one that will refuse it.
- A message containing `$` or a backslash must be single-quoted in the string
  form, or passed as an argv element. The alternative — trying to predict what a
  shell would expand — is exactly the reasoning that produces a bypass.
- The decision stays a pure function over `rawInput` plus injected resolvers, so
  the adversarial cases are unit tests rather than live drills. The fake ACP
  agent gained a scenario that *asks* for execute permission and runs only what
  it was approved for, which is what a real Profile does and what the earlier
  silent-spawn fixtures hid.

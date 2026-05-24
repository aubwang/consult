# Host Session cleanup with idle timeout fallback

Status: Superseded by [0016 Job-scoped Brokers with Host Session-scoped resume](0016-job-scoped-brokers.md)

**Brokers** should be cleaned up by a **Host Adapter** lifecycle hook when the Host exposes one, and should otherwise exit after an idle timeout. We chose this hybrid model because Claude Code can precisely signal **Host Session** end, while direct terminal use and some future Hosts may not expose an equivalent lifecycle event.

The idle fallback lives in the broker daemon. A broker schedules shutdown only
when it has no connected clients, no busy prompt turn, and no running Job. Any
new connection or active work clears the pending shutdown. The default timeout
is 30 minutes and can be changed with `CONSULT_BROKER_IDLE_TIMEOUT_MS`; values
less than or equal to zero disable the fallback.

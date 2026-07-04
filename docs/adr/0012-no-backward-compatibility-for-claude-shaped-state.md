# No backward compatibility for Claude-shaped state

Status: Accepted

The host-neutral refactor may start with fresh Consult state and does not need to preserve old job records or broker files that only encode Claude-specific session identity. We chose this because the project is still pre-release playground software, and carrying compatibility for the Claude-shaped prototype would slow the move to **Host** and **Host Session** terminology without protecting production users.

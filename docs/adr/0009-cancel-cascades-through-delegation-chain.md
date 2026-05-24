# Cancel cascades through a Delegation Chain

Cancelling a parent **Job** should cancel active descendant **Jobs** in the same **Delegation Chain**. We chose this because users expect cancelling a delegated effort to stop the child work it spawned, while cancelling a child remains scoped to that child subtree.

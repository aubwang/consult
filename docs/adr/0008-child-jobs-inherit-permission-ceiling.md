# Child Jobs inherit the parent permission ceiling

A child **Job** in a **Delegation Chain** cannot run with broader permissions than its parent **Job**. We chose this because otherwise a read-only delegated review could bypass its safety boundary by delegating a write-capable child job.

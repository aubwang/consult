# Claude names stay in the Claude Host Adapter

The host-neutral refactor will remove Claude-specific names from Consult Core state, broker scope, and environment contracts, while keeping Claude-facing slash command names in the Claude **Host Adapter**. We chose this because Claude Code remains one supported Host, but its lifecycle vocabulary should not define the portable delegation model.

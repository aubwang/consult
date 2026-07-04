# Portable Consult Core with Host Adapters

Status: Accepted

Consult will evolve from a Claude Code plugin into a portable **Consult Core** with thin **Host Adapters**. We chose this over building separate peer plugins that merely share code because profiles, brokers, jobs, state, permissions, and setup form one delegation model, while each Host only differs in command surface and lifecycle integration.

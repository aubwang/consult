# Consult-owned data root

Status: Accepted

Consult's default data root will move from Claude plugin storage to `~/.consult`, while preserving `CONSULT_DATA_DIR` as an override. We chose this because **Profiles**, **Jobs**, and **Brokers** now belong to **Consult Core**, not to the Claude Code **Host Adapter**.

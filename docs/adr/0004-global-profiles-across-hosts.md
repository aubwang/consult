# Profiles are global to Consult, not scoped to a Host

Configured **Profiles** belong to Consult as a whole and can be used from any **Host Adapter**. We chose this over per-Host profile stores because installing and authenticating a backend is independent of the Host that invokes it; Host-specific state remains limited to lifecycle and session ownership.

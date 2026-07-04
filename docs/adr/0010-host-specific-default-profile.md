# Hosts may have default Profiles

Status: Accepted

A **Host** may choose its own default **Profile**, falling back to Consult's global default when no Host-specific default is set. We chose this while keeping **Profiles** global because the same installed backend should be reusable everywhere, but the natural delegation target can differ by Host.

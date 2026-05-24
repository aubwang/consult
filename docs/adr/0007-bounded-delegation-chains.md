# Bounded Delegation Chains

Consult will allow delegated work to invoke Consult again, forming a **Delegation Chain**, but each child **Job** records its parent and depth and the chain is capped by a maximum depth. We chose this over forbidding recursion because Host-to-Profile delegation is the point of the project, and over unbounded recursion because agent loops are an obvious failure mode.

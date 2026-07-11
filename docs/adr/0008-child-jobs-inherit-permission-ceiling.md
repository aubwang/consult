# Child Jobs inherit the parent permission ceiling

Status: Accepted

A linked child **Job** in a **Delegation Chain** is policy-checked so it cannot
request a broader permission mode than its declared parent **Job**. We chose
this to keep cooperative delegation chains from widening authority accidentally.

ADR-0027 clarifies the security interpretation: parent linkage comes from
child-controlled arguments, environment, and writable product state rather
than an authenticated Consult-owned channel. An untrusted Profile can omit or
forge that linkage, so this ceiling is product policy, not an OS security
boundary. Confined nested delegation is unsupported; a trusted root Host should
start sibling confined Jobs.

# Profile setup and Host Adapter setup are separate

Status: Accepted

Consult will keep **Profile** setup separate from **Host Adapter** setup. We chose this because installing a Profile makes Consult able to delegate to a backend, while installing a Host Adapter makes a Host able to invoke Consult; the same product can support either role independently.

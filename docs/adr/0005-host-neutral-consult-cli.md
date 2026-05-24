# Host Adapters invoke a host-neutral consult CLI

**Host Adapters** will invoke Consult through a stable host-neutral `consult` CLI rather than importing internal JavaScript modules directly. We chose this because the current Claude adapter already shells into the companion process, and a CLI boundary keeps future adapters thin, language-agnostic, and isolated from broker/state internals.

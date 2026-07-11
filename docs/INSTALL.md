# Install Consult

Consult uses Node.js 24 or newer at runtime. The project uses Bun for dependency
management when developing from a checkout, but users do not need Bun to run the
published package.

If `node --version` is older than 24, update it with the version manager you
already use. For example:

```sh
# mise
mise use --global node@24

# or nvm
nvm install 24
nvm alias default 24
```

Open a new shell and confirm `node --version` before installing Consult.

## Native confinement prerequisites

Native arm64 macOS uses the built-in Seatbelt runtime and needs no additional
system package. An x64 Node process, including one running under Rosetta on
Apple Silicon, is unsupported even in inherited mode. Confirm with
`node -p process.arch`; it must print `arm64`. Linux
confinement requires `bwrap` (bubblewrap), `socat`, and `rg`
(ripgrep) on `PATH`. For example, on Debian or Ubuntu:

```sh
sudo apt-get install bubblewrap socat ripgrep
```

Ubuntu 24.04 and other hardened distributions may also restrict unprivileged
user namespaces through AppArmor or another system policy. Consult does not
weaken that policy automatically. Run `consult doctor --agent <profile>` and,
if namespace creation is denied, follow the distribution or administrator
policy for permitting bubblewrap in this environment. Deliberate ambient
execution remains available with `--sandbox inherit`; Consult never selects it
as an automatic fallback.

The pinned Sandbox Runtime interprets `*`, `?`, `[` and `]` in policy paths as
glob syntax rather than literal filename characters. Consult therefore fails
confined preflight clearly when the Workspace path contains one of those
characters. Rename or relocate that checkout before using confinement. Spaces
and Unicode path characters are supported.

## Install From npm

Install the supported package globally with one command:

```sh
npm install --global @aubwang/consult
```

This installs the `consult` command and its JavaScript runtime dependencies.
Re-run the same command to update to the latest published release. Linux system
prerequisites are installed separately as described above.

To develop Consult itself, clone the repository and link the checkout. Bun owns
the development lockfile and package installation; Node still executes the CLI
and tests:

```sh
git clone https://github.com/aubwang/consult.git
cd consult
bun install --frozen-lockfile
bun link
```

## Package name

`bun install --global @aubwang/consult` is also supported.

The package is scoped because the unscoped npm name `consult` belongs to an
unrelated project. The installed command is still named `consult`.

## Verify

```sh
node --version
consult help
consult setup
consult doctor --agent codex
```

`node --version` must report version 24 or newer. `consult setup` lists the
available Profiles and whether their agent executables are installed.

Confined Claude on macOS cannot read a login stored only in the macOS Keychain,
because Consult deliberately does not broker Keychain credentials. Supply one
supported token variable (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
`CLAUDE_CODE_OAUTH_TOKEN`) to the Host environment, or a stageable
`.claude/.credentials.json`, before running Doctor or delegation. The token is
passed only to the Job process tree; do not put it in project files or command
arguments.

If the shell cannot find `consult` after installation, inspect npm's global
prefix with `npm prefix --global` and ensure its executable directory is on
`PATH`. On macOS and Linux this is usually the `bin` directory under that
prefix.

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

## Install From GitHub

Until the npm package is published, install the current GitHub version globally
with one command:

```sh
npm install --global github:aubwang/consult
```

This installs the `consult` command and its runtime dependency. Re-run the same
command to update to the latest default branch.

To develop Consult itself, clone the repository and link the checkout. Bun owns
the development lockfile and package installation; Node still executes the CLI
and tests:

```sh
git clone https://github.com/aubwang/consult.git
cd consult
bun install --frozen-lockfile
bun link
```

## Install From npm

Once releases are published to npm:

```sh
npm install --global @aubwang/consult
# or
bun install --global @aubwang/consult
```

The package is scoped because the unscoped npm name `consult` belongs to an
unrelated project. The installed command is still named `consult`.

## Verify

```sh
node --version
consult help
consult setup
```

`node --version` must report version 24 or newer. `consult setup` lists the
available Profiles and whether their agent executables are installed.

If the shell cannot find `consult` after installation, inspect npm's global
prefix with `npm prefix --global` and ensure its executable directory is on
`PATH`. On macOS and Linux this is usually the `bin` directory under that
prefix.

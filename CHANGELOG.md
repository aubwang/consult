# Changelog

## [0.7.1](https://github.com/aubwang/consult/compare/v0.7.0...v0.7.1) (2026-07-14)


### Bug Fixes

* **skills:** scope delegation exec constraint so delegates keep reading files ([3172f5e](https://github.com/aubwang/consult/commit/3172f5e8d7ced3220d133c57fbfc9ca2ca7fe618))

## [0.7.0](https://github.com/aubwang/consult/compare/v0.6.0...v0.7.0) (2026-07-14)


### Features

* select the review model explicitly ([0eb8a20](https://github.com/aubwang/consult/commit/0eb8a200c8848779847adc55eb46f0fd323cf386))

## [0.6.0](https://github.com/aubwang/consult/compare/v0.5.2...v0.6.0) (2026-07-14)


### Features

* tune review reasoning effort ([88e19cb](https://github.com/aubwang/consult/commit/88e19cbf363ebe27d68d6535352dda0256c88c67))

## [0.5.2](https://github.com/aubwang/consult/compare/v0.5.1...v0.5.2) (2026-07-14)


### Bug Fixes

* close correctness races and validation gaps ([5e72a01](https://github.com/aubwang/consult/commit/5e72a01c5aa574cd03232b5e4bd4cdc3f6c1cb65))
* harden cancellation, cleanup, and confinement edge paths ([8b41d94](https://github.com/aubwang/consult/commit/8b41d9487d14299bdb673aed01132d0392c0cc13))
* release session brokers after unsettled policy violations ([d1225b9](https://github.com/aubwang/consult/commit/d1225b9176f10e40f2571a6d48c92514449f16d2))
* tolerate slow late prompt updates and darwin tmpdir symlinks ([949f0ad](https://github.com/aubwang/consult/commit/949f0ad5e5b1bf8223c16991c84ca73b18ed673a))

## [0.5.1](https://github.com/aubwang/consult/compare/v0.5.0...v0.5.1) (2026-07-13)


### Bug Fixes

* guard Claude async finalization ([39bba28](https://github.com/aubwang/consult/commit/39bba28a7adf3475d49d81b99afc05db4ace17f1))

## [0.5.0](https://github.com/aubwang/consult/compare/v0.4.0...v0.5.0) (2026-07-13)


### Features

* improve confined Claude startup ([9c3530b](https://github.com/aubwang/consult/commit/9c3530b94a30b3dff61b0e26b525075562e5c0e5))


### Bug Fixes

* migrate Codex ACP adapter ([ec56bcc](https://github.com/aubwang/consult/commit/ec56bcc3759c0b1f855ace7e0950fe45f47f2d30))
* support Homebrew Node in Linux confinement ([b19e3fe](https://github.com/aubwang/consult/commit/b19e3fe0b894f5671d5896eac2f01ece54aceaf5))
* use maintained Claude ACP package ([51b6291](https://github.com/aubwang/consult/commit/51b6291cd7be4d322763231e1a119ad1c0de222c))

## [0.4.0](https://github.com/aubwang/consult/compare/v0.3.0...v0.4.0) (2026-07-11)


### Features

* make job handoffs context efficient ([707c61d](https://github.com/aubwang/consult/commit/707c61d1fdf0bf97c4f733d31ec75f74326a9c43))
* make Job handoffs context efficient ([d817c53](https://github.com/aubwang/consult/commit/d817c531d47c07f7182ed09c28e565761308a7d9))


### Bug Fixes

* isolate profile credential overrides ([0944147](https://github.com/aubwang/consult/commit/09441470cecfdc2565010da1152039568035cc6c))

## [0.3.0](https://github.com/aubwang/consult/compare/v0.2.1...v0.3.0) (2026-07-11)


### Features

* add async Job orchestration ([bbc74b9](https://github.com/aubwang/consult/commit/bbc74b9f8729a8ea9c120a31eb6097630911784f))
* add dependent background jobs ([b8a31b2](https://github.com/aubwang/consult/commit/b8a31b2a1b078698248d15a3b199c61a1dde16c8))
* add portable multi-job wait ([3092427](https://github.com/aubwang/consult/commit/30924270980ec77e5843cb5b75b15b8e8b7e7760))
* clarify cross-agent delegation and CLI help ([6154d64](https://github.com/aubwang/consult/commit/6154d6410dcacde80a6b0922bc0093365a4ebb80))
* clarify cross-agent delegation and CLI help ([c2bfb01](https://github.com/aubwang/consult/commit/c2bfb018472e03b0dfc024b864131405ca6b9ba9))
* simplify skill installation ([64962b9](https://github.com/aubwang/consult/commit/64962b9b89cbddb5532031eea5eadca7448b2f01))
* simplify skill installation ([182caab](https://github.com/aubwang/consult/commit/182caabfe1cd5fc490ca018f50cf9de68f3d5c0b))


### Bug Fixes

* clean interrupted orchestration jobs ([20a2580](https://github.com/aubwang/consult/commit/20a25804f74341c10a60847091f28244acdd5ed4))
* stabilize package smoke and clarify delegation graphic ([bfe9bf9](https://github.com/aubwang/consult/commit/bfe9bf9f4d9aa02f8eaefdda0cfda7d09fb5627b))
* stabilize packed confinement smoke ([9438bf4](https://github.com/aubwang/consult/commit/9438bf476b00ec6cf6a501f669a2238961e7eb91))

## [0.2.1](https://github.com/aubwang/consult/compare/v0.2.0...v0.2.1) (2026-07-11)


### Bug Fixes

* harden delegation cleanup and improve onboarding ([55bda77](https://github.com/aubwang/consult/commit/55bda77baf209d497239daeb6605bd2b35265b91))
* retry transient package smoke cleanup races ([855411c](https://github.com/aubwang/consult/commit/855411cb40cb0ac154f73e36747db5d635134823))

## [0.2.0](https://github.com/aubwang/consult/compare/v0.1.3...v0.2.0) (2026-07-11)


### Features

* add authenticated job egress proxy ([eabe927](https://github.com/aubwang/consult/commit/eabe927ade4eb5ed8a0e679dc22898c6b514901c))
* add pinned public egress address policy ([fb309b4](https://github.com/aubwang/consult/commit/fb309b47748876830c2c73d2f40b9440a5c36884))
* add portable default Job Authority confinement ([70f7b3c](https://github.com/aubwang/consult/commit/70f7b3c0e1fa7d830c94469e958a284a549199b0))
* add portable job authority flags ([a69df7e](https://github.com/aubwang/consult/commit/a69df7e15096db3aaa2037ca0dc9b95c1d9304c6))
* apply job authority to review jobs ([9a9729a](https://github.com/aubwang/consult/commit/9a9729ac13e6bd43df559d4703d83c7ff9cc3773))
* bound job duration and persisted logs ([1f08d38](https://github.com/aubwang/consult/commit/1f08d38a0c7b93c376327bbf2eb9d2af30272a80))
* harden generated sandbox runtime policy ([bcd2301](https://github.com/aubwang/consult/commit/bcd2301946bae880b6ce68941b22f5fcf2b63aa5))
* honor explicit fetch authority ([96412bb](https://github.com/aubwang/consult/commit/96412bb6ef18de9cfae77496a95c90b52a53a5bc))
* launch profiles with confined job authority ([daef6af](https://github.com/aubwang/consult/commit/daef6afaa52f197f217672f564dba3e2a89cbfce))
* preflight job authority before job creation ([3645e34](https://github.com/aubwang/consult/commit/3645e34b00a075fd22035769aeb88179eb3fb1a3))
* preserve confined profile sessions selectively ([d0e2a54](https://github.com/aubwang/consult/commit/d0e2a54bd860a381475b82b62925ad8793a5f681))
* report job authority readiness in doctor ([3de44f5](https://github.com/aubwang/consult/commit/3de44f5522efd3f979c34dd3fc710e7e4f3bdfde))


### Bug Fixes

* advertise ipv4 loopback proxy endpoints ([2e8d46e](https://github.com/aubwang/consult/commit/2e8d46eaf982e3a0daed1f1ff9fad706e151bec7))
* canonicalize generated sandbox policy safely ([a9aeb89](https://github.com/aubwang/consult/commit/a9aeb89d516507e8d4a115f3d25cf85be88e759b))
* close macos confinement release gates ([1748248](https://github.com/aubwang/consult/commit/1748248ecc134bd2087c729044850a880a86a89c))
* confirm profile process termination ([fbfc49c](https://github.com/aubwang/consult/commit/fbfc49cf775e3e9f9d0c63f24db176602ce5eabe))
* enforce job authority at every launch boundary ([2291229](https://github.com/aubwang/consult/commit/22912296a7359a062aaffbe6ace524d29b29ef59))
* fail execute closed without network confinement ([ef78268](https://github.com/aubwang/consult/commit/ef782681cbe3251b13f975452fe7087c05571e70))
* harden confined launch recovery diagnostics ([4d13b10](https://github.com/aubwang/consult/commit/4d13b1006661f85dc26013a65a8c7246a9ef4247))
* honor explicit false authority flags ([73ec382](https://github.com/aubwang/consult/commit/73ec382a8d0f0faf12a164a5d2c61d1e62243fb3))
* include canonical host default write paths ([3b0ae5c](https://github.com/aubwang/consult/commit/3b0ae5c8394f9a53fc95a14a4428ba1d290ae091))
* limit macOS confinement to native arm64 ([#10](https://github.com/aubwang/consult/issues/10)) ([73b8a89](https://github.com/aubwang/consult/commit/73b8a8944129db6ff63da4ea52e8bb735db4399d))
* make macos job confinement portable ([db5ed9d](https://github.com/aubwang/consult/commit/db5ed9dfd1d7744c472164e294fe0a6f4ddf1ccf))
* make profile cleanup part of job finalization ([8770086](https://github.com/aubwang/consult/commit/8770086fd4fc55482fb39714345dccfec1c74563))
* own and terminate profile process groups ([56a0334](https://github.com/aubwang/consult/commit/56a033440cf1e67e1bfd3c6999ce023ecf100d3d))
* support Homebrew Node in macOS confinement ([#9](https://github.com/aubwang/consult/issues/9)) ([2b34291](https://github.com/aubwang/consult/commit/2b34291857b18f8a3a44ede0b6bc35902681d6df))


### Reverts

* remove non-distributable runtime patch ([26facee](https://github.com/aubwang/consult/commit/26faceed5e0d87e9042fe0dbe33bbb1e108fef30))

# Changelog

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

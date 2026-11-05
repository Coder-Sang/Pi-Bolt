# Fork Linux x64 local acceptance

Checked on 2026-11-04 in the managed Pi environment, on `feature/message-id`, based on
`afc9584e873204bfb7de57983f5653833f815d24` plus the uncommitted fork release changes. These are **unsigned local candidates**,
not production releases. Rebuilt after configuring the owner's supplied Ed25519 public key, with SPKI DER SHA-256
fingerprint `19c2aa9fb2c22aed6d2d5d4483ca08d7693c750b088027bf7b1a714e390508be`. Metadata records that fingerprint and
`dirty: true`. Public-key verification passes; clean-source and production-signature gates remain unsatisfied.
The owner's private key was never accessed or requested. No commit, push, merge, tag creation, release publication or
GitHub settings change was performed.

## Built artifacts

Pi-Bolt `1.0.10`, Pi `1.4.0`, patched Bun `1.4.3`, engine stamp `2e54e6641c78fd6d`.
`npm run build:offline` and all three AOT builds completed. Final local packing used
`XZ_OPT='--block-size=16MiB' scripts/package-release.sh --no-build` to increase compression parallelism, retaining the
script's `9e` preset. All three binaries report registered compiled code and contain the configured owner public key.
Artifacts are in the gitignored `dist/1.0.10/`; the complete 13-file manifest verifies locally with `--require-key`.

| Executable archive | SHA-256 |
| --- | --- |
| `pi-bolt-linux-x64.tar.xz` | `ea9d95bc13c46a49d4185bd56fc167a7f540f066df4cf1862c02c702d22c0205` |
| `pi-bolt-linux-x64-baseline.tar.xz` | `3f23db8a5528e8ec152b35283f7d5fa0697c24d3a3dba8855c2e0a8b6294bf41` |
| `pi-bolt-linux-x64-jit.tar.xz` | `5656a8a02981307e0f541dc2e34c290f3b9c492815aec099e838694698f6c22c` |

The runtime was downloaded from the exact upstream `bolt-v1.0.9` source in `runtime-source.json`. Its upstream signature,
checksum-file hash, signature hash, runtime archive hash, signed stamp, Bun version and GitHub build provenance passed
verification. The proof binds upstream `release.yml`, `refs/tags/bolt-v1.0.9` and commit
`739424a30d14afabc423ea1706f0f11c702eca9d`, on GitHub-hosted runners, run
[41239548608](https://github.com/opensec-git/Pi-Bolt/actions/runs/41239548608). A temporary verified GitHub CLI 2.103.3 was used
locally because the environment's system CLI 2.46.0 has no attestation command. Its official Linux archive SHA-256 was
`4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d`, matching GitHub's asset digest and checksum file.
The direct CLI fetch of an Azure-hosted temporary proof blob returned HTTP 403 in this environment. Fetching the inline
bundle through GitHub's repository API and verifying it cryptographically succeeded; no verification was disabled.
The fork's runtime archive is repackaged from this verified runtime and will need the fork release signature; an upstream runtime
signature does not authenticate this fork's Pi code or distribution.
For the public-key rebuild, both the build runtime and the repackaged runtime were also compared byte for byte by SHA-256
with the binary in that pinned upstream archive. The compile kit contains the configured owner public key.

## Passed checks

- Full `npm run check`: formatting/lint, pinned and runtime dependencies, relative imports, entry graphs, install lock,
  TypeScript and browser smoke. npm prints the repository's existing unsupported `min-release-age` configuration warnings;
  no new check diagnostic remains.
- Public-key update source regressions: 42 tests across signed installer, Windows update helpers, update rollback, install
  method and fork update discovery. Initial chain preparation also passed 83 Agent tests and 92 coding-agent regressions;
  those broader source suites were not repeated for the public-key-only update.
- Release/install script regressions: 46 Node tests across fork rules, prior test prerelease rules and npm helper fixtures.
  The signature tests use ephemeral in-memory test keys. They verify both Ed25519 formats, reject wrong signatures,
  tampered/extra files, dirty sources, mismatched versions and invalid locked runtimes, including unverified build provenance.
  Invalid runtime downloads preserve
  the existing usable runtime. The Linux installer was exercised against a signed loopback fixture and a wrong signature;
  it never downloaded an upstream npm executable and could not bypass signature checks using `PIBOLT_UNVERIFIED`.
- Public-only check of the configured installer: a real pinned upstream manifest/signature verifies with the upstream key,
  while the actual fork installer rejects it with the configured owner key, even with the checksum opt-in present. The
  upstream archive's bytes matched that manifest; no installation occurred and no owner's private key was needed.
- `actionlint` 1.7.12 on the new and changed workflows, without its optional ShellCheck integration; `bash -n` / `sh -n`
  on changed shell scripts. Workflow assertions cover candidate defaults, isolated signing and provenance, branch/environment constraints,
  existing-release refusal and disabled inherited upstream publication jobs.
- RPC acceptance on every rebuilt native, baseline and JIT binary in all three environments below: **54 passing cases**.
  The six executable archives (`.tar.gz` and `.tar.xz`) were separately checked to contain exactly those accepted binary
  bytes by SHA-256. The container runs used read-only mounts of the build output and checked the embedded owner public key.

| Environment | libc | Execution |
| --- | --- | --- |
| Managed Debian 13.6 x86_64 host | glibc 2.41 | Three variants, six RPC cases each |
| Debian 12 container | glibc 2.36 | Three variants, six RPC cases each; UID 1000, network disabled |
| Debian 11 container | glibc 2.31 | Three variants, six RPC cases each; UID 1000, network disabled |

Container images were pinned to their pulled digests:

- `python:3.11-slim-bookworm`: `sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd`.
- `python:3.11-slim-bullseye`: `sha256:9e25f400253a5fa3191813d6a67eb801ca1e6f012b3bd2588fa6920b59e3eba6`.

Each RPC run checks prompt admission, FollowUp and Steer ordered batches with duplicate text, explicit clearing,
abort with and without retained pending IDs, old clients without IDs, transformed/handled extension inputs, actual JSONL
responses, model request bodies and persisted sessions. Only a loopback fake provider is used. No real account or model is
contacted. The containers share the host kernel and CPU; this does not validate another kernel or a physical non-AVX2 CPU.

The complete `tests/pi/run.sh` extension suite passed again on each of the three rebuilt variants. This includes GC stress,
cached extension transformation, built-in modules, extension package dependency resolution, JIT-only FFI behavior and
fallback, `doctor`, child process/signal checks, Bedrock lazy loading against a deliberately closed loopback port, and
in-process grep/find. It made no successful external model call.

The first unwrapped baseline/native extension runs failed only the process-group assertion: the cloud workspace's PID 1
left the killed descendants as zombies (`/proc/<pid>/status` showed state `Z`, parent `1`). `kill(pid, 0)` consequently still
found them. All three complete suites then passed under a temporary Python wrapper that sets `PR_SET_CHILD_SUBREAPER` and
reaps adopted test descendants. The wrapper changes only its own test process tree. No assertion, runtime implementation,
system setting or security policy was weakened. Standard GitHub-hosted Ubuntu runners use their normal process reaper.

## Gates not executed

1. The owner's public key is configured and embedded in the rebuilt artifacts. Actual production signing with its private
   half has not run. The private key's format, secret availability and matching pair must be verified by the protected CI
   signing step, without sharing that private key with this workspace.
2. GitHub protected `release` environment, private secret, required reviewers, branch policy and branch/tag rules remain
   administrator configuration. A workflow's `environment: release` declaration alone does not create these protections.
3. The new fork workflows have not run on GitHub, and no numeric production tag or signed stable Release was created.
   They must be tested after reviewed changes and owner configuration reach the authorized production branch.
4. The release skill's real-provider prompt and interactive tmux smoke have not run: they require separate authorization
   and intended provider access. The fake-provider tests do not replace that release gate.
5. Windows, macOS, ARM64, musl, older glibc, and physical CPUs without AVX2 were not accepted as production targets.
   These results support Linux x64 on the tested glibc environments only.

The earlier read-only remote check found `bolt-v1.9.0-message` pointing to
`2772f525461b79ef38a33d31014763dab08dd3b7`, and the feature branch at
`afc9584e873204bfb7de57983f5653833f815d24`. This public-key update performed no remote mutation and retained the separate
unsigned test prerelease.

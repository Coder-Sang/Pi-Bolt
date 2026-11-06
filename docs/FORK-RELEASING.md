# Fork Linux x64 releases

The first production target is `Coder-Sang/Pi-Bolt`, branch `pi-bolt`, Linux x64. `VERSION`, `npm/package.json` and the
launcher agree on `1.1.1`; Pi's source packages keep their independent upstream `1.5.0` version. Release tags are exactly
`bolt-vVERSION` with three canonical numeric components. `bolt-vX.Y.Z-message` is a separate unsigned test prerelease path.
Existing tags and releases are never moved, overwritten or used as a retry target for changed source.

## Two trust chains

`runtime-source.json` pins the upstream runtime repository and numeric release, archive SHA-256, signed checksum-file
SHA-256, signature SHA-256, Bun version, engine stamp and attested source commit. `scripts/fetch-runtime.sh --locked` verifies
the upstream signature using `keys/upstream-runtime.pub`, all pins, and its GitHub build provenance before replacing a usable
runtime. The proof must name the exact upstream release workflow, tag and commit, running on GitHub-hosted runners. It
fetches inline bundles from GitHub's repository API and cryptographically verifies them with `gh attestation verify`; a
failed or unavailable proof stops the fetch. A recent GitHub CLI supporting the attestation source flags is required.
A source engine change without a
reviewed matching lock fails. `PIBOLT_DOWNLOAD_BASE` can select a mirror but cannot change the accepted signature or pins.
The fork repackages the verified runtime; that new archive needs the fork signature. The upstream signature authenticates
the runtime source, not the fork's Pi binary, compile kit or new distribution.

Fork release checksums use the owner's **different Ed25519 key**, with its public half in `keys/release.pub`. The configured
public key has SPKI DER SHA-256 fingerprint `19c2aa9fb2c22aed6d2d5d4483ca08d7693c750b088027bf7b1a714e390508be`.
Only this public half was supplied to the workspace. Installers and update code carry the same public key; missing
keys, signature failures, mismatched versions and unsigned downloads fail closed. `configure-fork-release.mjs` refuses the
upstream runtime key as a fork signing key. This preparation creates no production private key or persistent credential.

The fork manifest covers exactly the Linux x64 archives, compile kit, runtime, installer, pinned extension list,
`RUNTIME_STAMP`, `RUNTIME_SOURCE.json` and `RELEASE_BUILD.json`. Metadata records source commit, workflow commit, dirty-tree
status, target repository, platform and signing-key fingerprint. Publishing refuses dirty candidates, another source
commit, runtime pins or signing key. Both raw Ed25519 and OpenSSH-format signatures must verify.

## Owner configuration before production

1. Keep the production Ed25519 private key on the trusted owner-controlled device and in the protected signing environment,
   outside the repository and this workspace. To supply or rotate the public key, use only its reviewed public PEM:

   ```sh
   node scripts/configure-fork-release.mjs --public-key /path/to/fork-public.pem
   node scripts/configure-fork-release.mjs --check --require-key
   ```

   The synchronizer updates the public file and its embedded copies in the installers and binary source. Review and commit
   these changes, then rebuild; an already-built binary still has the key it was compiled with.

2. Configure a GitHub `release` environment with required reviewers and a deployment branch policy accepting only `pi-bolt`.
   Put the private PEM in its `PIBOLT_SIGNING_KEY` secret. Do not use a repository-wide signing secret. Protect `pi-bolt`,
   require the `fork-ci` Linux x64 check, and protect creation/movement/deletion of `bolt-v*` tags. These are administrator
   operations; the local preparation does not apply them.

3. Review `docs/fork-releases/VERSION.md`, source changes and public-key fingerprint. Merge reviewed source into `pi-bolt`,
   then create the new annotated numeric tag from that reviewed commit. Neither the preparation scripts nor test runs create
   a production tag. The existing `bolt-v1.9.0-message` remains unchanged.

## Candidate and publication commands

Run the new workflow on a branch containing its definition, with an existing numeric tag. A candidate run does not sign,
create a Release or use signing secrets:

```sh
gh workflow run fork-release.yml -R Coder-Sang/Pi-Bolt --ref pi-bolt -f tag=bolt-v1.0.10 -f publish=false
```

The explicit production operation is:

```sh
gh workflow run fork-release.yml -R Coder-Sang/Pi-Bolt --ref pi-bolt -f tag=bolt-v1.0.10 -f publish=true
```

An optional `-f release_title=1.0.9.a` changes only the GitHub display title. The tag, internal version, signed metadata and
installation/update paths keep the numeric `1.0.10` version.

### Signed Message ID builds

The build based on upstream `bolt-v1.1.1` (commit `0c8faeb30b28671c9aac9ed8bdc62b3dda2dd462`) keeps the existing
Message ID RPC contract and fork download/signing identity. Its tag and executable version are `bolt-v1.1.1` and `1.1.1`;
the title identifies it as `Pi-Bolt 1.1.1 Message ID build 1`. Numeric tags remain compatible with existing installers and
updaters. The build identifier is a display label, not SemVer build metadata. Each later build needs a new version/tag;
published tags and assets are never reused or overwritten.

Publish this tested build as a signed prerelease:

```sh
gh workflow run fork-release.yml -R Coder-Sang/Pi-Bolt --ref pi-bolt \
  -f tag=bolt-v1.1.1 -f publish=true -f prerelease=true \
  -f 'release_title=Pi-Bolt 1.1.1 Message ID build 1'
```

This adds `--prerelease --latest=false` to release creation, while retaining the same signature, provenance, source,
clean-tree, branch and absent-release checks. The stable `latest` endpoint keeps the previous stable release. Install the
build explicitly with `PIBOLT_VERSION=bolt-v1.1.1`, or select the beta channel; beta selects the highest numeric release
including prereleases. Stable publication remains the default when `prerelease` is omitted.

The read-only build downloads the pinned verified runtime, builds all x64 variants and runs offline RPC and extension
acceptance on each unpacked archive. Only a successful build can reach the protected publisher. It checks tag ancestry
against its trusted branch snapshot, rechecks the remote tag, refuses any existing release including a draft, verifies all
payload files without a private key, then signs in its isolated signing step. It creates the selected release type with
`--verify-tag`: stable releases become latest, and signed prerelease builds use `--latest=false`. Legacy unsigned test
prereleases also retain `--latest=false`.
Nothing publishes npm packages, an upstream website or package-manager feeds.

The build has no OIDC or signing permissions. For an explicit production run only, a separate job attests the tested
candidate files using GitHub OIDC, with no release private key. The publisher verifies that provenance on `SHA256SUMS`
against the trusted `pi-bolt` workflow snapshot before its signing step; the verified manifest hashes bind every payload.
The certificate identifies the workflow snapshot, while `RELEASE_BUILD.json` records the selected tag's source commit.
The publisher checks both identities and requires the source tag to be an ancestor of that snapshot. It never treats an
attestation from a feature-branch workflow as production provenance.

If an operation fails, first inspect remote tag, run and release state. Do not blindly re-dispatch after a timeout. An
existing or partial release requires an explicit recovery decision; no step uses asset clobbering or release editing.

## Acceptance and limits

`tests/pi/rpc-message-id.py` uses a loopback-only streaming model fixture and isolated agent/session directories. It checks
initial prompt admission, ordered FollowUp and Steer consumption, identical text with different IDs, clear, abort, legacy
clients, extension transformations/handled inputs and absence of IDs/queue metadata from model requests and saved sessions.
It makes no real model call and uses no user credentials. Abort retains unconsumed queued IDs until an explicit clear;
dequeue batch IDs identify input handoff, not the end of an assistant response.

`scripts/fork-release.test.mjs` checks the fork key boundary, both signature formats, corrupted/extra/dirty payload rejection,
locked-runtime failure behavior, actual Linux installer verification and workflow publication guards. Test private keys are
in-memory fixtures, never production credentials. `docs/FORK-ACCEPTANCE.md` records the concrete local platform results.

Actual signing with the owner's production key, GitHub environment/ruleset enforcement and a real provider/interactive
smoke test remain separate owner-authorized gates. Passing the local fake-provider suite does not claim these ran.

# Message ID test builds

The `release` workflow accepts `bolt-vX.Y.Z-message` tags on its separate Linux x64 test path. It packages the default,
baseline and JIT builds with the same scripts as a release, tests each unpacked build, and uploads Actions artifacts for
14 days. It uses the latest upstream runtime only after checking its release signature and checksum, as `ci` does.

A separate publisher then creates an **unsigned, unofficial GitHub prerelease** for the existing test tag, with every
artifact attached for long-term downloads. It explicitly sets `--prerelease --latest=false`, never calls the formal
`publish` workflow, and does not publish to npm, the site or Homebrew. The build job has read-only repository permissions;
only the publisher has `contents: write`, and it checks the artifacts without executing the tagged source. `AUTO_RELEASE`
does not affect this path. Set `dry_run=true` to build and test without creating a prerelease.

The publisher verifies that the remote tag still points to the tested source, validates the artifact set, checksums and
metadata, and refuses any existing Release, including a draft. Permission errors stop publication. It never moves a tag,
overwrites assets or edits an existing Release. If creation or upload fails, inspect the actual Release and run state
before retrying; a partially created draft requires a separate recovery decision.

The test tag is a build label, independent of `VERSION`. For example, `bolt-v1.9.0-message` currently builds source
`2772f525461b79ef38a33d31014763dab08dd3b7` with package version `1.0.9`. Package and launcher versions must still agree
with `VERSION`; the test workflow leaves them unchanged. `TEST_BUILD.json` records the tag, actual version, source
commit, runtime version and stamp, workflow revision and run URL. `SHA256SUMS` covers the archives and this metadata but
is unsigned. These archives are downloaded and unpacked directly, rather than installed through the signed release
installers. After unpacking an executable archive, run `./pi --version` or `./pi --mode rpc` from its directory.

## Build the existing tag

First commit and push the workflow change on `feature/message-id`. Keep the existing tag pointing at its original
commit. Then manually dispatch the updated branch's workflow, which checks out and builds the tag's source:

```bash
gh workflow run release.yml -R Coder-Sang/Pi-Bolt --ref feature/message-id -f tag=bolt-v1.9.0-message
```

The existing `release.yml` must be registered and enabled in Actions on the default branch. A fork may need its owner
to enable Actions first. [GitHub supports selecting a branch with `--ref` when dispatching an existing workflow.](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

This is a new manual run. Re-running a run created from the old tag does not load the updated branch workflow:
[GitHub re-runs retain the original event's commit and ref.](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

After a successful run, download the attached files from
[the test prerelease](https://github.com/Coder-Sang/Pi-Bolt/releases/tag/bolt-v1.9.0-message), or use:

```bash
gh release download bolt-v1.9.0-message -R Coder-Sang/Pi-Bolt -D message-test
(cd message-test && sha256sum -c SHA256SUMS)
```

Actions artifacts remain available for 14 days, including for a dry run. Open the run's **Artifacts** section and download
`test-bolt-v1.9.0-message-linux-x64`, or use its run ID:

```bash
gh run download RUN_ID -R Coder-Sang/Pi-Bolt -n test-bolt-v1.9.0-message-linux-x64 -D message-test
(cd message-test && sha256sum -c SHA256SUMS)
```

New tags matching `bolt-vX.Y.Z-message` automatically take the test path when pushed, provided their commits contain
the updated workflow. Other suffixes are rejected. A feature branch push alone does not start this workflow.

## Formal releases

Numeric `bolt-vX.Y.Z` tags still use the existing release path, including exact `VERSION` agreement, runtime provenance
checks and all platform builds. The `publish` workflow still requires the `pi-bolt` branch, verifies tag ancestry,
uses the protected `release` environment and checks the signing key. See [RELEASING.md](RELEASING.md).

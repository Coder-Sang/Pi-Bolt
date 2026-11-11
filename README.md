# Coder-Sang Pi-Bolt fork

This fork adds caller message IDs and ordered queue lifecycle events to Pi-Bolt. Its first production distribution supports
**Linux x64 with glibc**. The upstream compiler, Pi agent and licenses are retained; see [Architecture](docs/ARCHITECTURE.md)
and [Third-party notices](THIRD_PARTY_NOTICES.md).

Message ID candidate version: `1.2.1` (Pi `1.5.2`), based on upstream `bolt-v1.2.1`. The existing
[`bolt-v1.9.0-message` test prerelease](https://github.com/Coder-Sang/Pi-Bolt/releases/tag/bolt-v1.9.0-message) remains an
unsigned test build of Pi-Bolt `1.0.9`.

## Install a production release

After a signed stable release is published:

```sh
curl -fsSL https://raw.githubusercontent.com/Coder-Sang/Pi-Bolt/pi-bolt/install.sh | sh
```

The installer and `pi-bolt update` use [this fork's releases](https://github.com/Coder-Sang/Pi-Bolt/releases). The installer
requires the fork signature and fails before downloading when its public key is unconfigured. Checksum-only opt-ins cannot
disable signature verification. Binary downloads use GitHub; this fork does not publish npm packages, Homebrew formulas,
Scoop manifests or an installation website in its first release.

The configured fork public key has SPKI DER SHA-256 fingerprint
`19c2aa9fb2c22aed6d2d5d4483ca08d7693c750b088027bf7b1a714e390508be`. The private key is kept outside this checkout.

Linux x64 variants are `x64`, `x64-baseline` and `x64-jit`. For a baseline build:

```sh
curl -fsSL https://raw.githubusercontent.com/Coder-Sang/Pi-Bolt/pi-bolt/install.sh | PIBOLT_VARIANT=x64-baseline sh
```

Run `./pi` from an unpacked executable archive, or `pi-bolt` after installation. `pi-bolt --mode rpc` speaks JSONL.
Configure your real provider separately. See [RPC](packages/coding-agent/docs/rpc.md), [Providers](packages/coding-agent/docs/providers.md)
and [Plugins](docs/PLUGINS.md). Windows, macOS and ARM64 remain outside this fork's initial production support commitment.

## Build and verify locally

Use Node 24, the standard Linux build tools and a recent GitHub CLI with `gh attestation verify` and its source-policy flags.

```sh
scripts/fetch-runtime.sh --locked
scripts/prepare-pi.sh
scripts/package-release.sh
python3 tests/pi/rpc-message-id.py "$PWD/out/pi-bolt-baseline/pi"
node scripts/fork-release.mjs prepare --dir dist/1.2.1 --tag bolt-v1.2.1
node scripts/fork-release.mjs verify --dir dist/1.2.1 --tag bolt-v1.2.1
```

The runtime is pinned in [`runtime-source.json`](runtime-source.json). It must verify with the independent upstream runtime
key, match the recorded checksums and signature, and have the exact engine stamp and Bun version. Fork releases use their
own Ed25519 key. The runtime's GitHub build provenance must also match its pinned workflow, tag and source commit. The
upstream runtime key is never accepted as the fork release key.

`fork-ci` checks source changes and exercises a compiled baseline binary. `fork-release` builds and tests all three Linux
x64 variants. Numeric tag pushes produce candidates only; publication is an explicit dispatch from `pi-bolt`, after a review
in the protected `release` environment. The inherited upstream release, publishing and automatic tagging jobs are disabled
for this fork. Message test tags retain their independent unsigned prerelease path.

See [Fork release preparation](docs/FORK-RELEASING.md) for public-key configuration, protections, publication and acceptance.

## Pi and Pi-Bolt side by side

Pi-Bolt shares Pi's agent directory and session format. Set `PI_CODING_AGENT_DIR` to a separate directory when isolation is
required. The additional `message_id` values and queue tracking metadata are runtime correlation data; they are excluded
from model payloads and persisted sessions.

## Upstream and license

Built on [opensec-git/Pi-Bolt](https://github.com/opensec-git/Pi-Bolt), [Pi](https://github.com/earendil-works/pi) and
[Bun](https://github.com/oven-sh/bun). MIT and the bundled dependencies' licenses apply; see [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Upstream benchmark results are in [BENCHMARKS.md](docs/BENCHMARKS.md).

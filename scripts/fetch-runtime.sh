#!/usr/bin/env bash
# Downloads the released Pi-Bolt runtime (instead of building it with build-runtime.sh) to $PIBOLT_WORK/runtime/bun.
#
# Usage: scripts/fetch-runtime.sh [--locked] [--version bolt-vX.Y.Z]
# --locked requires the exact signed upstream runtime recorded in runtime-source.json and this checkout's engine stamp.
# Environment: PIBOLT_DOWNLOAD_BASE (a mirror of the release files)
# Upstream runtimes use keys/upstream-runtime.pub, independently of this fork's release signing key.
source "$(dirname "$0")/lib/common.sh"

TAG=""
LOCKED=""
while [ $# -gt 0 ]; do
	case "$1" in
	--locked) LOCKED=1 ;;
	--version) TAG="$2"; shift ;;
	-h | --help) sed -n '2,5p' "$0"; exit 0 ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
need curl
if [ -n "$LOCKED" ]; then
	locked=$(python3 - "$PIBOLT_ROOT/runtime-source.json" "$PIBOLT_PLATFORM" <<'PY'
import json, re, sys
source = json.load(open(sys.argv[1]))
assert source["repository"] == "opensec-git/Pi-Bolt" and source["publicKey"] == "keys/upstream-runtime.pub"
assert re.fullmatch(r"bolt-v[0-9]+\.[0-9]+\.[0-9]+", source["tag"])
assert re.fullmatch(r"[0-9a-f]{16}", source["runtimeStamp"])
assert re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", source["bunVersion"])
provenance = source["attestation"]
assert provenance["signerWorkflow"] == "opensec-git/Pi-Bolt/.github/workflows/release.yml"
assert provenance["sourceRef"] == "refs/tags/" + source["tag"]
assert re.fullmatch(r"[0-9a-f]{40}", provenance["sourceCommit"])
values = [source["archives"][sys.argv[2]], source["checksumsSha256"], source["signatureSha256"]]
assert all(re.fullmatch(r"[0-9a-f]{64}", value) for value in values)
print(source["tag"], *values, source["runtimeStamp"], source["bunVersion"], provenance["sourceCommit"])
PY
	)
	read -r locked_tag archive_sum sums_sum signature_sum expected_stamp expected_version source_commit <<< "$locked"
	[ -z "$TAG" ] || [ "$TAG" = "$locked_tag" ] || die "--version differs from the locked upstream runtime"
	TAG=$locked_tag
	[ "$("$PIBOLT_ROOT/scripts/runtime-stamp.sh")" = "$expected_stamp" ] || die "the locked runtime is not this checkout's engine; build and review a matching runtime"
fi
TAG=${TAG:-latest}
REPO="https://github.com/opensec-git/Pi-Bolt"
if [ "$TAG" = latest ]; then BASE="$REPO/releases/latest/download"; else BASE="$REPO/releases/download/$TAG"; fi
BASE="${PIBOLT_DOWNLOAD_BASE:-$BASE}"
NAME=pi-bolt-runtime-$PIBOLT_PLATFORM.tar.gz

# verify_signature FILE SIG KEY: dies unless SIG is KEY's signature of FILE.
verify_signature() {
	local openssl candidate
	for candidate in openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
		command -v "$candidate" >/dev/null 2>&1 || continue
		case "$("$candidate" version 2>/dev/null)" in "OpenSSL "[3-9]* | "OpenSSL "[1-9][0-9]*) openssl=$candidate; break ;; esac
	done
	if [ -n "${openssl:-}" ]; then
		"$openssl" pkeyutl -verify -pubin -inkey "$3" -rawin -in "$1" -sigfile "$2" >/dev/null 2>&1 || die "the signature of $1 does not verify"
	elif command -v bun >/dev/null 2>&1; then
		bun -e 'const c = require("node:crypto"), f = require("node:fs"); const [file, sig, key] = process.argv.slice(-3);
process.exit(c.verify(null, f.readFileSync(file), f.readFileSync(key, "utf8"), f.readFileSync(sig)) ? 0 : 1);' "$1" "$2" "$3" ||
			die "the signature of $1 does not verify"
	else
		die "OpenSSL 3 or Bun is needed to check the release's signature"
	fi
	log "signature verified"
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
curl -fsSL -o "$TMP/SHA256SUMS.sig" "$BASE/SHA256SUMS.sig" || die "no signature at $BASE/SHA256SUMS.sig: the runtime is not used"
verify_signature "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig" "$PIBOLT_ROOT/keys/upstream-runtime.pub"
if [ -n "$LOCKED" ]; then
	[ "$(sha256 < "$TMP/SHA256SUMS" | cut -c1-64)" = "$sums_sum" ] || die "the upstream checksums differ from runtime-source.json"
	[ "$(sha256 < "$TMP/SHA256SUMS.sig" | cut -c1-64)" = "$signature_sum" ] || die "the upstream signature differs from runtime-source.json"
fi
if [ "$TAG" != latest ]; then
	[ "$(head -n 1 "$TMP/SHA256SUMS")" = "# pi-bolt ${TAG#bolt-v}" ] || die "the signed checksums are not $TAG's"
fi
log "downloading $BASE/$NAME"
curl -fL --progress-bar -o "$TMP/$NAME" "$BASE/$NAME"
check_sum "$TMP" "$NAME" || die "checksum mismatch for $NAME"
if [ -n "$LOCKED" ]; then
	[ "$(sha256 < "$TMP/$NAME" | cut -c1-64)" = "$archive_sum" ] || die "the runtime archive differs from runtime-source.json"
	need gh
	# Fetch inline bundles from GitHub's repository API, then verify them cryptographically. This also works behind proxies
	# that cannot fetch the API's separate, temporary blob-storage URLs. Missing bundles are a failure, not a bypass.
	gh api --method GET "repos/opensec-git/Pi-Bolt/attestations/sha256:$archive_sum" \
		--jq '.attestations[].bundle | select(. != null) | @json' > "$TMP/provenance.jsonl" || die "could not fetch upstream runtime provenance"
	[ -s "$TMP/provenance.jsonl" ] || die "the locked upstream runtime has no build provenance bundle"
	gh attestation verify "$TMP/$NAME" --repo opensec-git/Pi-Bolt \
		--signer-workflow opensec-git/Pi-Bolt/.github/workflows/release.yml --source-ref "refs/tags/$TAG" \
		--source-digest "$source_commit" --deny-self-hosted-runners --bundle "$TMP/provenance.jsonl" || die "the locked upstream runtime's build provenance does not verify"
fi
tar -C "$TMP" -xzf "$TMP/$NAME"
# Which engine it is, as the release's signed checksums give it (scripts/build-pi.sh records it, for `pi-bolt doctor`).
if curl -fsSL -o "$TMP/RUNTIME_STAMP" "$BASE/RUNTIME_STAMP" 2>/dev/null && check_sum "$TMP" RUNTIME_STAMP; then
	stamp_verified=1
else
	stamp_verified=""
fi
if [ -n "$LOCKED" ]; then
	[ -n "$stamp_verified" ] && [ "$(cat "$TMP/RUNTIME_STAMP")" = "$expected_stamp" ] || die "missing or mismatched signed runtime stamp"
	[ "$("$TMP/pi-bolt-runtime-$PIBOLT_PLATFORM/bun" --version)" = "$expected_version" ] || die "the runtime's Bun version differs from runtime-source.json"
fi
# Do not replace a usable runtime when any upstream verification fails.
mkdir -p "$PIBOLT_WORK/runtime"
install -m 755 "$TMP/pi-bolt-runtime-$PIBOLT_PLATFORM/bun" "$PIBOLT_WORK/runtime/bun.part"
mv "$PIBOLT_WORK/runtime/bun.part" "$PIBOLT_WORK/runtime/bun"
if [ -n "$stamp_verified" ]; then
	cp "$TMP/RUNTIME_STAMP" "$PIBOLT_WORK/runtime/RUNTIME_STAMP"
else
	rm -f "$PIBOLT_WORK/runtime/RUNTIME_STAMP"
fi
if [ -n "$LOCKED" ]; then
	cp "$PIBOLT_ROOT/runtime-source.json" "$PIBOLT_WORK/runtime/UPSTREAM_SOURCE.json"
else
	rm -f "$PIBOLT_WORK/runtime/UPSTREAM_SOURCE.json"
fi
log "runtime: $PIBOLT_WORK/runtime/bun (Bun $("$PIBOLT_WORK/runtime/bun" --version))"

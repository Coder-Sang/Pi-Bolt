import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const publish = parse(readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"));
const testBuild = release.jobs["test-build"];
const testPublish = release.jobs["test-publish"];

function step(name) {
	const found = testBuild.steps.find((entry) => entry.name === name);
	assert.ok(found, `Missing workflow step: ${name}`);
	return found;
}

function temporaryDirectory(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-test-build-workflow-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function run(script, env, cwd = repoRoot) {
	return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
}

test("test tags isolate the read-only build and prerelease publisher from the formal release chain", () => {
	assert.deepEqual(release.on.push.tags, ["bolt-v*"]);
	assert.equal(release.on.workflow_dispatch.inputs.tag.required, true);
	const selector = "endsWith(github.event.inputs.tag || github.ref_name, '-message')";
	assert.equal(testBuild.if, `\${{ ${selector} }}`);
	assert.equal(release.jobs.prepare.if, `\${{ github.repository == 'opensec-git/Pi-Bolt' && !${selector} }}`);
	assert.equal(release.jobs.draft.if, `\${{ github.repository == 'opensec-git/Pi-Bolt' && !inputs.dry_run && !${selector} }}`);
	assert.equal(release.jobs.build.needs, "prepare");
	assert.equal(release.jobs["build-musl"].needs, "prepare");
	assert.equal(release.jobs["build-windows"].needs, "prepare");
	assert.deepEqual(release.jobs.draft.needs, ["prepare", "build", "build-musl", "build-windows"]);
	assert.deepEqual(testBuild.permissions, { contents: "read" });
	assert.equal(testBuild.environment, undefined);
	assert.doesNotMatch(JSON.stringify(testBuild), /secrets\.|GH_TOKEN|gh (?:release|workflow)|attest-build-provenance/);
	assert.equal(testPublish.needs, "test-build");
	assert.equal(testPublish.if, `\${{ ${selector} && !inputs.dry_run }}`);
	assert.deepEqual(testPublish.permissions, { contents: "write" });
	assert.equal(testPublish.environment, undefined);
	assert.doesNotMatch(JSON.stringify(testPublish), /secrets\.|gh workflow|--clobber|gh release (?:edit|upload|delete)|actions\/checkout/);
	const checkout = testBuild.steps.find((entry) => entry.uses?.startsWith("actions/checkout@"));
	assert.equal(checkout.with.ref, "refs/tags/${{ env.TAG }}");
	assert.equal(checkout.with["persist-credentials"], false);
	const upload = testBuild.steps.find((entry) => entry.uses?.startsWith("actions/upload-artifact@"));
	assert.equal(upload.with.name, "test-${{ env.TAG }}-linux-x64");
	assert.equal(upload.with["if-no-files-found"], "error");
	assert.equal(upload.with["retention-days"], 14);
});

test("the real test-tag validator accepts the existing label and rejects malformed inputs", () => {
	const validate = step("The test tag").run;
	for (const tag of ["bolt-v1.9.0-message", "bolt-v0.0.1-message", "bolt-v12.34.56-message"]) {
		assert.equal(run(validate, { TAG: tag }).status, 0, tag);
	}
	for (const tag of [
		"bolt-v1.9.0",
		"bolt-v1.9-message",
		"bolt-v1.9.0-beta",
		"bolt-v1.9.0-message-extra",
		"bolt-v1x9x0-message",
		"refs/tags/bolt-v1.9.0-message",
		"bolt-v1.9.0-message\n",
		"ignored\nbolt-v1.9.0-message",
		"bolt-v1.9.0-message; true",
		"",
	]) {
		assert.notEqual(run(validate, { TAG: tag }).status, 0, JSON.stringify(tag));
	}
});

test("the source version stays independent of the test label and must be a numeric version", (t) => {
	const directory = temporaryDirectory(t);
	const envFile = join(directory, "env");
	const env = {
		TAG: "bolt-v1.9.0-message",
		GITHUB_ENV: envFile,
		GITHUB_OUTPUT: join(directory, "output"),
		GIT_DIR: execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: repoRoot, encoding: "utf8" }).trim(),
		GIT_WORK_TREE: repoRoot,
	};
	writeFileSync(join(directory, "VERSION"), "1.0.9\n");
	assert.equal(run(step("Source version").run, env, directory).status, 0);
	assert.equal(readFileSync(envFile, "utf8"), "VERSION=1.0.9\n");
	assert.equal(readFileSync(join(directory, "VERSION"), "utf8"), "1.0.9\n");
	for (const invalid of ["1.0.9-message", "1x0x9", "1.0.9\nignored", "1.0"]) {
		writeFileSync(join(directory, "VERSION"), invalid);
		assert.notEqual(run(step("Source version").run, env, directory).status, 0, invalid);
	}
});

function testArtifacts(t) {
	const directory = temporaryDirectory(t);
	const dist = join(directory, "dist/1.0.9");
	mkdirSync(dist, { recursive: true });
	mkdirSync(join(directory, ".work/runtime"), { recursive: true });
	writeFileSync(join(directory, ".work/runtime/bun"), "#!/bin/sh\nprintf '1.4.2\\n'\n", { mode: 0o755 });
	writeFileSync(join(directory, ".work/runtime/RUNTIME_STAMP"), "signed-runtime-stamp\n");
	const files = ["pi-bolt-kit-linux-x64.tar.gz", "pi-bolt-runtime-linux-x64.tar.gz", "extensions.txt"];
	for (const variant of ["", "-baseline", "-jit"]) {
		for (const ext of ["gz", "xz"]) files.push(`pi-bolt-linux-x64${variant}.tar.${ext}`);
	}
	for (const file of files) {
		writeFileSync(join(dist, file), `fixture: ${file}\n`);
	}
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: repoRoot, encoding: "utf8" }).trim();
	const env = {
			TAG: "bolt-v1.9.0-message",
			VERSION: "1.0.9",
			GIT_DIR: gitDir,
			GIT_WORK_TREE: repoRoot,
			GITHUB_WORKFLOW_REF: "Coder-Sang/Pi-Bolt/.github/workflows/release.yml@refs/heads/feature/message-id",
			GITHUB_WORKFLOW_SHA: "a".repeat(40),
			GITHUB_SERVER_URL: "https://github.com",
			GITHUB_REPOSITORY: "Coder-Sang/Pi-Bolt",
			GITHUB_RUN_ID: "123",
			GITHUB_STEP_SUMMARY: join(directory, "summary"),
			RUNNER_TEMP: directory,
			SOURCE_COMMIT: commit,
	};
	const result = run(step("Test build metadata and checksums").run, env, directory);
	assert.equal(result.status, 0, result.stderr);
	return { directory, dist, commit, env, files: [...files, "TEST_BUILD.json", "SHA256SUMS"] };
}

test("metadata distinguishes source and workflow revisions and all uploaded files have checksums", (t) => {
	const { dist, commit } = testArtifacts(t);
	const metadata = JSON.parse(readFileSync(join(dist, "TEST_BUILD.json"), "utf8"));
	assert.equal(metadata.kind, "test");
	assert.equal(metadata.tag, "bolt-v1.9.0-message");
	assert.equal(metadata.version, "1.0.9");
	assert.equal(metadata.commit, commit);
	assert.equal(metadata.workflowCommit, "a".repeat(40));
	assert.equal(metadata.runtimeVersion, "1.4.2");
	assert.equal(metadata.runtimeStamp, "signed-runtime-stamp");
	assert.equal(metadata.runUrl, "https://github.com/Coder-Sang/Pi-Bolt/actions/runs/123");
	assert.equal(run("sha256sum -c SHA256SUMS", {}, dist).status, 0);
	writeFileSync(join(dist, "TEST_BUILD.json"), "tampered");
	assert.notEqual(run("sha256sum -c SHA256SUMS", {}, dist).status, 0);
});

function mockGitHub(directory) {
	const bin = join(directory, "mock-bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_GH_LOG"
case "$*" in
  *"/commits/"*) printf '%s\\n' "$MOCK_TAG_COMMIT" ;;
  *"/releases?per_page=100"*)
    if [ "$MOCK_LIST_ERROR" = true ]; then echo 'Resource not accessible by integration (HTTP 403)' >&2; exit 1; fi
    printf '%s' "$MOCK_EXISTING_RELEASE"
    ;;
  *"/releases/tags/"*) cat "$MOCK_RELEASE_JSON" ;;
  "release create "*) printf '%s\\n' 'https://github.com/Coder-Sang/Pi-Bolt/releases/tag/bolt-v1.9.0-message' ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	return { PATH: `${bin}:${process.env.PATH}`, MOCK_GH_LOG: join(directory, "gh.log") };
}

test("prerelease preflight refuses existing releases, permission failures and changed tags", (t) => {
	const directory = temporaryDirectory(t);
	const script = testPublish.steps.find((entry) => entry.name === "Existing tag and release").run;
	const env = {
		...mockGitHub(directory),
		TAG: "bolt-v1.9.0-message",
		SOURCE_COMMIT: "b".repeat(40),
		MOCK_TAG_COMMIT: "b".repeat(40),
		GITHUB_REPOSITORY: "Coder-Sang/Pi-Bolt",
	};
	assert.equal(run(script, env, directory).status, 0);
	assert.notEqual(run(script, { ...env, MOCK_EXISTING_RELEASE: "123" }, directory).status, 0);
	assert.notEqual(run(script, { ...env, MOCK_LIST_ERROR: "true" }, directory).status, 0);
	assert.notEqual(run(script, { ...env, MOCK_TAG_COMMIT: "c".repeat(40) }, directory).status, 0);
	assert.notEqual(run(script, { ...env, TAG: "bolt-v1.0.9" }, directory).status, 0);
	assert.doesNotMatch(readFileSync(env.MOCK_GH_LOG, "utf8"), /release create/);
});

test("only a complete verified artifact set can be published as an unsigned non-latest prerelease", (t) => {
	const { directory, dist, env, files } = testArtifacts(t);
	const verify = testPublish.steps.find((entry) => entry.name === "Verify test artifacts and write release notes").run;
	assert.equal(run(verify, env, dist).status, 0);
	const notes = readFileSync(join(directory, "test-release-notes.md"), "utf8");
	assert.match(notes, /Unsigned, unofficial/);
	assert.match(notes, /package VERSION: `1\.0\.9`/);
	assert.match(notes, /SHA256SUMS` is unsigned/);
	assert.notEqual(run(verify, { ...env, SOURCE_COMMIT: "c".repeat(40) }, dist).status, 0);
	writeFileSync(join(dist, "unexpected.txt"), "unexpected");
	assert.notEqual(run(verify, env, dist).status, 0);
	rmSync(join(dist, "unexpected.txt"));
	const responseFile = join(directory, "release.json");
	writeFileSync(
		responseFile,
		JSON.stringify({
			tag_name: env.TAG,
			prerelease: true,
			draft: false,
			html_url: "https://github.com/Coder-Sang/Pi-Bolt/releases/tag/bolt-v1.9.0-message",
			assets: files.map((name) => ({ name, state: "uploaded", size: Buffer.byteLength(readFileSync(join(dist, name))) })),
		}),
	);
	const ghEnv = { ...env, ...mockGitHub(directory), MOCK_RELEASE_JSON: responseFile };
	const create = testPublish.steps.find((entry) => entry.name === "Create test prerelease").run;
	const result = run(create, ghEnv, dist);
	assert.equal(result.status, 0, result.stderr);
	const commands = readFileSync(ghEnv.MOCK_GH_LOG, "utf8");
	assert.match(commands, /release create bolt-v1\.9\.0-message/);
	assert.match(commands, /--verify-tag/);
	assert.match(commands, /--prerelease --latest=false/);
	assert.doesNotMatch(commands, /release (?:edit|upload|delete)/);
	writeFileSync(join(dist, "pi-bolt-linux-x64.tar.gz"), "tampered");
	assert.notEqual(run(verify, env, dist).status, 0);
});

test("formal release tag, version, branch, environment and signing guards remain enforced", () => {
	const validate = release.jobs.prepare.steps.find((entry) => entry.name === "The tag").run;
	assert.equal(run(validate, { TAG: "bolt-v1.0.9" }).status, 0);
	assert.notEqual(run(validate, { TAG: "bolt-v1.9.0-message" }).status, 0);
	const versionCheck = release.jobs.prepare.steps.find((entry) => entry.id === "check").run;
	assert.match(versionCheck, /test "bolt-v\$version" = "\$TAG"/);
	assert.equal(publish.jobs.verify.environment, "release");
	const runGuard = publish.jobs.verify.steps.find((entry) => entry.name === "The run").run;
	assert.equal(run(runGuard, { TAG: "bolt-v1.0.9", GITHUB_REF: "refs/heads/pi-bolt" }).status, 0);
	assert.notEqual(run(runGuard, { TAG: "bolt-v1.0.9", GITHUB_REF: "refs/heads/feature/message-id" }).status, 0);
	assert.notEqual(run(runGuard, { TAG: "bolt-v1.9.0-message", GITHUB_REF: "refs/heads/pi-bolt" }).status, 0);
	const ancestry = publish.jobs.verify.steps.find((entry) => entry.name === "The tag is on pi-bolt").run;
	assert.match(ancestry, /git merge-base --is-ancestor "refs\/tags\/\$TAG\^\{commit\}" "\$GITHUB_SHA"/);
	const sign = publish.jobs.verify.steps.find((entry) => entry.name === "Sign");
	assert.equal(sign.env.SIGNING_KEY, "${{ secrets.PIBOLT_SIGNING_KEY }}");
	assert.match(sign.run, /cmp -s - \.\.\/keys\/release\.pub/);
});

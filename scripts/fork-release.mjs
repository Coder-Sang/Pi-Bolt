import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, verify } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoot, synchronizeForkRelease } from "./configure-fork-release.mjs";
import { sshPublicKey } from "./lib/sshsig.mjs";

export const linuxReleaseFiles = [
	...['', '-baseline', '-jit'].flatMap((variant) => ['gz', 'xz'].map((ext) => `pi-bolt-linux-x64${variant}.tar.${ext}`)),
	"pi-bolt-kit-linux-x64.tar.gz", "pi-bolt-runtime-linux-x64.tar.gz", "extensions.txt", "install.sh",
	"RUNTIME_STAMP", "RUNTIME_SOURCE.json", "RELEASE_BUILD.json",
].sort();

export function prepareForkRelease({ root = defaultRoot, dir, tag, workflowCommit = process.env.GITHUB_WORKFLOW_SHA ?? null }) {
	const config = synchronizeForkRelease({ root, check: true });
	assert.equal(tag, `bolt-v${config.version}`, "the production tag must exactly match VERSION");
	const runtime = JSON.parse(readFileSync(join(root, "runtime-source.json"), "utf8"));
	assert.deepEqual(JSON.parse(readFileSync(join(root, ".work/runtime/UPSTREAM_SOURCE.json"), "utf8")), runtime,
		"fetch the locked signed upstream runtime before packaging");
	assert.equal(readFileSync(join(root, ".work/runtime/RUNTIME_STAMP"), "utf8").trim(), runtime.runtimeStamp);
	for (const name of ["install.sh", "extensions.txt"]) copyFileSync(join(root, name), join(dir, name));
	writeFileSync(join(dir, "RUNTIME_STAMP"), `${runtime.runtimeStamp}\n`);
	writeFileSync(join(dir, "RUNTIME_SOURCE.json"), `${JSON.stringify(runtime, null, 2)}\n`);
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim().length > 0;
	const metadata = { repository: config.repository, platform: config.platform, tag, version: config.version, commit,
		workflowCommit, dirty, keyFingerprint: config.keyFingerprint, runtimeSource: runtime };
	writeFileSync(join(dir, "RELEASE_BUILD.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	const sums = [`# pi-bolt ${config.version}`];
	for (const name of linuxReleaseFiles) {
		const file = join(dir, name);
		assert.ok(lstatSync(file).isFile(), `not a regular release file: ${name}`);
		sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${name}`);
	}
	writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
	return metadata;
}

export function verifyForkRelease({ root = defaultRoot, dir, tag, commit, requireKey = false, requireClean = false, signature = false }) {
	const config = synchronizeForkRelease({ root, check: true, requireKey });
	assert.equal(tag, `bolt-v${config.version}`, "the production tag must exactly match VERSION");
	const permitted = new Set([...linuxReleaseFiles, "SHA256SUMS", "SHA256SUMS.sig", "SHA256SUMS.sshsig"]);
	for (const name of readdirSync(dir)) {
		assert.ok(permitted.has(name), `unexpected release file: ${name}`);
		assert.ok(lstatSync(join(dir, name)).isFile(), `not a regular release file: ${name}`);
	}
	const sums = readFileSync(join(dir, "SHA256SUMS"));
	const lines = sums.toString("utf8").trimEnd().split("\n");
	assert.equal(lines.shift(), `# pi-bolt ${config.version}`);
	const seen = [];
	for (const line of lines) {
		const entry = /^([0-9a-f]{64})  ([a-zA-Z0-9_.-]+)$/.exec(line);
		assert.ok(entry, "invalid release checksum line");
		assert.ok(linuxReleaseFiles.includes(entry[2]), `unexpected checksum entry: ${entry[2]}`);
		assert.equal(createHash("sha256").update(readFileSync(join(dir, entry[2]))).digest("hex"), entry[1], `checksum mismatch: ${entry[2]}`);
		seen.push(entry[2]);
	}
	assert.deepEqual(seen.sort(), linuxReleaseFiles, "missing or duplicate release files");
	const metadata = JSON.parse(readFileSync(join(dir, "RELEASE_BUILD.json"), "utf8"));
	assert.equal(metadata.repository, config.repository);
	assert.equal(metadata.platform, config.platform);
	assert.equal(metadata.version, config.version);
	assert.equal(metadata.tag, tag);
	assert.match(metadata.commit, /^[0-9a-f]{40}$/);
	if (commit) assert.equal(metadata.commit, commit, "artifact source differs from the selected tag");
	if (requireClean) assert.equal(metadata.dirty, false, "a dirty source tree cannot be published");
	assert.equal(metadata.keyFingerprint, config.keyFingerprint, "the artifact was built for another signing key");
	const runtime = JSON.parse(readFileSync(join(root, "runtime-source.json"), "utf8"));
	assert.deepEqual(metadata.runtimeSource, runtime);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "RUNTIME_SOURCE.json"), "utf8")), runtime);
	assert.equal(readFileSync(join(dir, "RUNTIME_STAMP"), "utf8"), `${runtime.runtimeStamp}\n`);
	assert.equal(readFileSync(join(dir, "install.sh"), "utf8"), readFileSync(join(root, "install.sh"), "utf8"),
		"the installer must be the reviewed branch's installer and trust key");
	if (signature) {
		assert.ok(config.keyFingerprint, "a fork public key is required to verify release signatures");
		assert.ok(lstatSync(join(dir, "SHA256SUMS.sshsig")).isFile(), "the SSH-format signature is required too");
		assert.ok(verify(null, sums, readFileSync(join(root, config.publicKey)), readFileSync(join(dir, "SHA256SUMS.sig"))), "fork signature does not verify");
		const temporary = mkdtempSync(join(tmpdir(), "pi-fork-signature-"));
		try {
			const signers = join(temporary, "allowed_signers");
			writeFileSync(signers, `pi-bolt namespaces="pi-bolt-release" ${sshPublicKey(readFileSync(join(root, config.publicKey)))}\n`);
			execFileSync("ssh-keygen", ["-Y", "verify", "-f", signers, "-I", "pi-bolt", "-n", "pi-bolt-release", "-s", resolve(dir, "SHA256SUMS.sshsig")], { input: sums, stdio: ["pipe", "pipe", "pipe"] });
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
	return { ...metadata, fileCount: linuxReleaseFiles.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		const command = args.shift();
		const value = (name) => args[args.indexOf(name) + 1];
		assert.ok(args.includes("--dir") && args.includes("--tag"), "--dir and --tag are required");
		const options = { dir: resolve(value("--dir")), tag: value("--tag") };
		let result;
		if (command === "prepare") result = prepareForkRelease(options);
		else {
			assert.equal(command, "verify", "use prepare or verify");
			result = verifyForkRelease({ ...options, commit: args.includes("--commit") ? value("--commit") : undefined,
				requireKey: args.includes("--require-key"), requireClean: args.includes("--require-clean"), signature: args.includes("--signature") });
		}
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}

// Synchronize a supplied public key and fork download identity. Never generates or stores a private key.
import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

export function forkConfiguration(root = defaultRoot) {
	const config = JSON.parse(readFileSync(join(root, "fork-release.json"), "utf8"));
	assert.equal(config.repository, "Coder-Sang/Pi-Bolt");
	assert.equal(config.branch, "pi-bolt");
	assert.equal(config.platform, "linux-x64");
	assert.equal(config.publicKey, "keys/release.pub");
	const version = readFileSync(join(root, "VERSION"), "utf8").trim();
	assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
	assert.equal(JSON.parse(readFileSync(join(root, "npm/package.json"), "utf8")).version, version);
	assert.ok(readFileSync(join(root, "npm/bin/pi-bolt"), "utf8").includes(`\nVERSION=${version}\n`));
	return { ...config, version };
}

export function publicKeyFields(pem, upstreamPem) {
	if (!pem.trim()) return { pem: "", base64: "", ssh: "", fingerprint: null };
	assert.match(pem.trim(), /^-----BEGIN PUBLIC KEY-----/);
	assert.ok(!pem.includes("PRIVATE KEY"), "supply a public key, never a private key");
	const key = createPublicKey(pem);
	assert.equal(key.asymmetricKeyType, "ed25519", "fork releases require an Ed25519 public key");
	const der = key.export({ format: "der", type: "spki" });
	const upstream = createPublicKey(upstreamPem).export({ format: "der", type: "spki" });
	assert.ok(!der.equals(upstream), "the upstream runtime key cannot sign fork releases");
	const raw = key.export({ format: "jwk" });
	const bytes = Buffer.from(raw.x, "base64url");
	const ssh = Buffer.alloc(4 + 11 + 4 + 32);
	ssh.writeUInt32BE(11, 0);
	ssh.write("ssh-ed25519", 4);
	ssh.writeUInt32BE(32, 15);
	bytes.copy(ssh, 19);
	return {
		pem: key.export({ format: "pem", type: "spki" }).toString(),
		base64: der.toString("base64"),
		ssh: `ssh-ed25519 ${ssh.toString("base64")}`,
		fingerprint: createHash("sha256").update(der).digest("hex"),
	};
}

export function synchronizeForkRelease({ root = defaultRoot, publicKey, check = false, requireKey = false } = {}) {
	const config = forkConfiguration(root);
	const current = readFileSync(join(root, config.publicKey), "utf8");
	const fields = publicKeyFields(publicKey ?? current, readFileSync(join(root, "keys/upstream-runtime.pub"), "utf8"));
	assert.ok(!requireKey || fields.fingerprint, "fork signing key is not configured; supply the owner's reviewed Ed25519 public key");
	const repo = `https://github.com/${config.repository}`;
	const api = `https://api.github.com/repos/${config.repository}`;
	const raw = `https://raw.githubusercontent.com/${config.repository}/${config.branch}`;
	const replacements = new Map([
		["install.sh", [
			[/^RELEASE_KEY="[\s\S]*?"\r?$/m, `RELEASE_KEY="${fields.pem.trimEnd()}"`],
			[/^RELEASE_SSH_KEY="[^"]*"/m, `RELEASE_SSH_KEY="${fields.ssh}"`],
			[/^REPO="[^"]*"/m, `REPO="${repo}"`],
			[/^API="[^"]*"/m, `API="${api}"`],
		]],
		["install.ps1", [
			[/^\$PiBoltReleaseKey = '[^']*'/m, `$PiBoltReleaseKey = '${fields.base64}'`],
			[/^\$PiBoltRepo = '[^']*'/m, `$PiBoltRepo = '${repo}'`],
			[/^\$PiBoltApi = '[^']*'/m, `$PiBoltApi = '${api}'`],
		]],
		["npm/install.cjs", [
			[/^const RELEASE_KEY = "[^"]*";/m, `const RELEASE_KEY = "${fields.base64}";`],
			[/^const REPO = "[^"]*";/m, `const REPO = "${repo}";`],
		]],
		["packages/coding-agent/src/pi-bolt.ts", [
			[/export const PIBOLT_INSTALL_URL =[\s\S]*?;/, `export const PIBOLT_INSTALL_URL =\n\tprocess.platform === "win32"\n\t\t? "${raw}/install.ps1"\n\t\t: "${raw}/install.sh";`],
			[/export const PIBOLT_RELEASE_KEY = (?:`[\s\S]*?`|"");/, fields.pem ? `export const PIBOLT_RELEASE_KEY = \`${fields.pem}\`;` : 'export const PIBOLT_RELEASE_KEY = "";'],
			[/export const PIBOLT_RELEASES_URL = "[^"]*";/, `export const PIBOLT_RELEASES_URL = "${repo}/releases";`],
			[/export const PIBOLT_LATEST_RELEASE_API = "[^"]*";/, `export const PIBOLT_LATEST_RELEASE_API = "${api}/releases/latest";`],
			[/export const PIBOLT_RELEASES_API = "[^"]*";/, `export const PIBOLT_RELEASES_API = "${api}/releases?per_page=30";`],
		]],
	]);
	const expected = new Map([[config.publicKey, fields.pem]]);
	for (const [file, edits] of replacements) {
		let contents = readFileSync(join(root, file), "utf8");
		for (const [pattern, replacement] of edits) {
			assert.ok(pattern.test(contents), `missing release identity declaration: ${file} ${pattern}`);
			contents = contents.replace(pattern, replacement);
		}
		contents = contents.replaceAll("https://pi-bolt.opensec.in/install.sh", `${raw}/install.sh`)
			.replaceAll("https://pi-bolt.opensec.in/install.ps1", `${raw}/install.ps1`);
		expected.set(file, contents);
	}
	for (const [file, contents] of expected) {
		if (check) assert.equal(readFileSync(join(root, file), "utf8"), contents, `run configure-fork-release.mjs to synchronize ${file}`);
		else writeFileSync(join(root, file), contents);
	}
	return { ...config, keyFingerprint: fields.fingerprint };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		const keyAt = args.indexOf("--public-key");
		const publicKey = keyAt < 0 ? undefined : readFileSync(args[keyAt + 1], "utf8");
		const result = synchronizeForkRelease({ publicKey, check: args.includes("--check"), requireKey: args.includes("--require-key") });
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ResourceManifest {
	format: number;
	pluginVersion: string;
	platform: string;
	dependencyMode: string;
	files: Record<string, { sha256: string; bytes: number }>;
}

export async function verifyResources(directory: string, version: string): Promise<void> {
	const manifest = JSON.parse(await readFile(join(directory, 'resources.json'), 'utf8')) as ResourceManifest;
	if (manifest.format !== 2 || manifest.pluginVersion !== version ||
		manifest.platform !== 'darwin-arm64' || manifest.dependencyMode !== 'global-npm') {
		throw new Error('The platform package version does not match. Reinstall the complete package.');
	}
	for (const name of ['main.js', 'search-host.cjs', 'manifest.json']) {
		const expected = manifest.files?.[name];
		if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
			throw new Error('The platform package resource manifest is incomplete.');
		}
		const hash = createHash('sha256');
		let bytes = 0;
		for await (const data of createReadStream(join(directory, name))) {
			const chunk = data as Buffer;
			bytes += chunk.length;
			hash.update(chunk);
		}
		if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) {
			throw new Error(`Platform resource failed integrity verification: ${name}`);
		}
	}
}

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { loadGlobalLanceDB } from './backend/global-sdk';
import { probeDatabase } from './backend/probe';
import type { NativeProbeResult } from './runtime/protocol';
import { serveSearch } from './backend/serve';

const [root, requestId, globalModulesPath, mode] = process.argv.slice(2);
let diagnostic = 'The search probe requires a Node.js IPC parent and absolute directories.';

async function main(): Promise<void> {
	if (!process.send || !root || !isAbsolute(root) || !requestId || !globalModulesPath || !isAbsolute(globalModulesPath)) {
		throw new Error(diagnostic);
	}
	diagnostic = 'This prototype requires macOS on Apple Silicon and Node.js 22 or newer.';
	if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) < 22) {
		throw new Error(diagnostic);
	}
	if (mode !== 'serve') process.once('disconnect', () => process.exit(1));
	diagnostic = 'Could not load global LanceDB. Check the Node.js version and run npm install -g @lancedb/lancedb@latest.';
	const { sdk, version, entry } = await loadGlobalLanceDB(globalModulesPath);
	if (!process.connected) return;
	if (mode === 'serve') {
		diagnostic = 'Could not open the keyword index. Check the environment or rebuild the cache with Obsidian closed.';
		try { await serveSearch(root, sdk, requestId); }
		catch (error) {
			if (error instanceof Error && error.message.startsWith('This index is occupied.')) diagnostic = error.message;
			throw error;
		}
		return;
	}
	process.send({ requestId, phase: 'ready' });
	diagnostic = 'The installed LanceDB did not pass the ICU search check. Check the environment before using this version.';
	await mkdir(root, { recursive: true });
	const directory = await mkdtemp(join(root, 'probe-'));
	let checks: string[];
	try {
		checks = await probeDatabase(directory, sdk);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	const result: NativeProbeResult = {
		sdkVersion: version,
		sdkEntry: entry,
		versions: process.versions,
		platform: process.platform,
		arch: process.arch,
		checks,
	};
	process.send({ requestId, result }, (error) => process.exit(error ? 1 : 0));
}

void main().catch(() => {
	// Surface the failed stage without copying third-party exceptions into the UI.
	if (process.connected && process.send) {
		process.send({ requestId, error: diagnostic }, () => process.exit(1));
	} else process.exit(1);
});

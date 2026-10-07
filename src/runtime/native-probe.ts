import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeSettings } from '../settings';
import { resolveGlobalRuntime } from './global-runtime';
import type { NativeProbeResult, ProbeMessage } from './protocol';
import { verifyResources } from './resources';

interface ProbeOptions {
	pluginDirectory: string;
	cacheDirectory: string;
	version: string;
	settings: RuntimeSettings;
	signal: AbortSignal;
}

export async function runNativeProbe(options: ProbeOptions): Promise<NativeProbeResult> {
	const { pluginDirectory, cacheDirectory, version, settings, signal } = options;
	const runtime = await resolveGlobalRuntime(settings, signal);
	await verifyResources(pluginDirectory, version);
	if (signal.aborted) throw new Error('Runtime check cancelled.');
	await mkdir(cacheDirectory, { recursive: true });
	const directory = await mkdtemp(join(cacheDirectory, 'check-'));
	try {
		if (signal.aborted) throw new Error('Runtime check cancelled.');
		return await new Promise((resolve, reject) => {
			const requestId = randomUUID();
			const child = spawn(runtime.nodePath, [join(pluginDirectory, 'search-host.cjs'), directory, requestId, runtime.globalModulesPath], {
				cwd: pluginDirectory,
				// The child loads the explicit global package; no inherited injection flags or credentials.
				env: { PATH: '' },
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			});
			let result: NativeProbeResult | undefined;
			let failure: Error | undefined;
			const cancel = () => {
				failure = new Error('Runtime check cancelled.');
				child.kill('SIGKILL');
			};
			const timeout = window.setTimeout(() => {
				failure = new Error('The native runtime check timed out.');
				child.kill('SIGKILL');
			}, 30_000);
			const cleanup = () => {
				window.clearTimeout(timeout);
				signal.removeEventListener('abort', cancel);
			};
			signal.addEventListener('abort', cancel, { once: true });
			child.on('message', (message: ProbeMessage) => {
				if (message?.requestId !== requestId || failure) return;
				if (message.error) failure = new Error(message.error);
				if (message.result) result = message.result;
			});
			child.once('error', () => {
				cleanup();
				reject(new Error('Could not start the configured Node.js executable.'));
			});
			child.once('exit', (code) => {
				cleanup();
				if (failure) reject(failure);
				else if (code !== 0 || !result) reject(new Error('The installed LanceDB did not pass the native search check.'));
				else resolve(result);
			});
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

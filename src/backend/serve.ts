import { mkdir } from 'node:fs/promises';
import type { LanceDB } from './global-sdk';
import { IndexStore } from './index-store';
import type { SearchRequest } from '../search/types';
import { acquireWriterLock } from './writer-lock';

export async function serveSearch(directory: string, sdk: LanceDB, startupId: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	const releaseLock = await acquireWriterLock(directory);
	let index: IndexStore | undefined;
	let queue = Promise.resolve();
	let stopping = false;
	const close = async () => {
		if (stopping) return;
		stopping = true;
		await queue;
		index?.close();
		await releaseLock();
		process.exit(0);
	};
	try {
		index = await IndexStore.open(directory, sdk);
		if (!process.connected) { await close(); return; }
		process.on('message', (message: SearchRequest & { requestId: string }) => {
			if (stopping || !message?.requestId) return;
			if (message.type === 'close') { void close(); return; }
			queue = queue.then(async () => {
				try {
					const result = await index!.execute(message);
					if (process.connected) process.send?.({ requestId: message.requestId, result }, (error) => { if (error) void close(); });
				} catch {
					// Native exceptions may include indexed text; report the operation, not its payload.
					const error = message.type.startsWith('semantic-')
						? 'The semantic index operation failed. Check the environment or rebuild the semantic index.'
						: `Could not ${message.type} the local index. Check the environment or rebuild the keyword index.`;
					if (process.connected) process.send?.({ requestId: message.requestId, error }, (sendError) => { if (sendError) void close(); });
				}
			});
		});
		process.once('disconnect', () => { void close(); });
		process.once('SIGTERM', () => { void close(); });
		process.send?.({ requestId: startupId, phase: 'ready' }, (error) => { if (error) void close(); });
	} catch (error) {
		index?.close();
		await releaseLock();
		throw error;
	}
}

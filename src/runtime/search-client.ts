import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import type { RuntimeSettings } from '../settings';
import type { IndexSnapshot, SearchCandidate, SearchHit, SearchMatches, SearchReply, SearchRequest, SearchResponse } from '../search/types';
import { resolveGlobalRuntime } from './global-runtime';
import { verifyResources } from './resources';

export interface SearchClientOptions {
	pluginDirectory: string;
	cacheDirectory: string;
	version: string;
	settings: RuntimeSettings;
	signal: AbortSignal;
	onFailure: (message: string, recoverable: boolean) => void;
}

export class SearchClient {
	private child?: ChildProcess;
	private startup?: Promise<void>;
	private closed = false;
	private failure?: Error;
	private ready = false;
	private readonly pending = new Map<string, { resolve: (value: SearchReply['result']) => void; reject: (error: Error) => void }>();
	private readonly abort = () => { this.close(); };

	constructor(private readonly options: SearchClientOptions) {
		options.signal.addEventListener('abort', this.abort, { once: true });
	}

	private async start(): Promise<void> {
		if (this.closed || this.options.signal.aborted) throw new Error('Search stopped.');
		const runtime = await resolveGlobalRuntime(this.options.settings, this.options.signal);
		await verifyResources(this.options.pluginDirectory, this.options.version);
		if (this.closed || this.options.signal.aborted) throw new Error('Search stopped.');
		await new Promise<void>((resolve, reject) => {
			const requestId = randomUUID();
			const child = spawn(runtime.nodePath, [
				join(this.options.pluginDirectory, 'search-host.cjs'), this.options.cacheDirectory,
				requestId, runtime.globalModulesPath, 'serve',
			], { cwd: this.options.pluginDirectory, env: { PATH: '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
			this.child = child;
			const timeout = setTimeout(() => {
				this.fail(new Error('Starting the keyword index timed out.'));
				child.kill('SIGKILL');
			}, 30_000);
			child.on('message', (message: SearchReply & { phase?: string }) => {
				if (message.requestId === requestId) {
					clearTimeout(timeout);
					if (message.error) { this.failure = new Error(message.error); reject(this.failure); }
					else if (message.phase === 'ready') { this.ready = true; resolve(); }
					return;
				}
				const pending = this.pending.get(message.requestId);
				if (!pending) return;
				this.pending.delete(message.requestId);
				if (message.error) pending.reject(new Error(message.error));
				else pending.resolve(message.result);
			});
			child.once('error', () => {
				clearTimeout(timeout);
				const error = new Error('Could not start the configured Node.js executable.');
				this.fail(error); reject(error);
			});
			child.once('exit', () => {
				clearTimeout(timeout);
				this.child = undefined;
				const error = this.failure ?? new Error(this.closed ? 'Search stopped.' : 'The search process exited.');
				this.fail(error, this.ready); reject(error);
			});
		});
	}

	private fail(error: Error, recoverable = false): void {
		this.failure = error;
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
		if (!this.closed) this.options.onFailure(error.message, recoverable);
	}

	async request(request: SearchRequest): Promise<SearchReply['result']> {
		if (this.closed) throw new Error('Search stopped.');
		if (this.failure) throw this.failure;
		await (this.startup ??= this.start());
		if (!this.child?.connected || this.closed) throw new Error('Search stopped.');
		return await new Promise((resolve, reject) => {
			const requestId = randomUUID();
			const timeout = setTimeout(() => {
				const error = new Error('The keyword index stopped responding. Reload the plugin to retry.');
				this.fail(error);
				this.child?.kill('SIGKILL');
			}, 60_000);
			this.pending.set(requestId, {
				resolve: (value) => { clearTimeout(timeout); resolve(value); },
				reject: (error) => { clearTimeout(timeout); reject(error); },
			});
			this.child!.send({ ...request, requestId }, (error) => {
				if (error) this.fail(new Error('Could not communicate with the search process.'));
			});
		});
	}

	async snapshot(): Promise<IndexSnapshot> { return await this.request({ type: 'snapshot' }) as IndexSnapshot; }
	async search(query: string, accept: (candidate: SearchCandidate) => boolean = () => true): Promise<SearchResponse> {
		const result = await this.request({ type: 'search', query }) as SearchMatches;
		const candidates = result.hits.filter(accept);
		const hits = await this.request({ type: 'snippets', query, candidates: candidates.slice(0, 50) }) as SearchHit[];
		return { hits: hits.filter(accept), total: candidates.length };
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.options.signal.removeEventListener('abort', this.abort);
		this.fail(new Error('Search stopped.'));
		const child = this.child;
		if (!child) return;
		if (child.connected) child.send({ type: 'close', requestId: randomUUID() }, () => { /* Exit handles completion. */ });
		const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
		child.once('exit', () => clearTimeout(timeout));
	}
}

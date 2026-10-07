import { clearTimeout, setTimeout } from 'node:timers';
import { EmbeddingClient, EmbeddingError } from './client';
import { configurationKey, restrictScope, vectorSpace, type EmbeddingSettings, type SemanticApproval } from './settings';
import { SemanticIndexer, type SemanticSource } from './indexer';
import type { VectorSnapshot } from './types';
import type { SearchResponse } from '../search/types';
import { parseQuery } from '../search/query';
import { retrieveSemantic } from './retrieval';

interface Options {
	settings(): EmbeddingSettings;
	save(): Promise<void>;
	changed: () => void;
	signal: AbortSignal;
}

export class SemanticEngine {
	private work = new AbortController();
	private tested?: { configuration: string; dimensions: number };
	private indexer?: SemanticIndexer;
	private running?: Promise<void>;
	private building = false;
	private dirty = false;
	private failure?: string;
	private timer?: ReturnType<typeof setTimeout>;
	private epoch = 0;
	private disposed = false;
	constructor(private readonly source: SemanticSource, private readonly client: EmbeddingClient, private readonly options: Options) {
		options.signal.addEventListener('abort', this.stop, { once: true });
	}
	get status(): string {
		if (this.failure) return this.failure;
		if (this.building) return 'Building semantic index…';
		const settings = this.options.settings();
		if (!settings.approval) return 'Semantic search is off. Test a connection and build an index to enable it.';
		if (!this.matches(settings.approval)) return 'The model settings changed. Test the connection and build a new semantic index.';
		if (settings.paused) return 'Remote calls paused.';
		return this.running ? 'Updating semantic index…' : `${this.indexer?.indexed.size ?? 0} notes indexed for semantic search`;
	}
	get canBuild(): boolean {
		try { return this.tested?.configuration === configurationKey(this.options.settings()) && !this.building; } catch { return false; }
	}
	private matches(approval: SemanticApproval): boolean {
		try { return approval.configuration === configurationKey(this.options.settings()); } catch { return false; }
	}
	private cancel(): void { this.epoch++; this.work.abort(); this.work = new AbortController(); clearTimeout(this.timer); this.timer = undefined; }
	private stop = () => { this.disposed = true; this.cancel(); this.options.signal.removeEventListener('abort', this.stop); };
	private allowed(epoch: number): boolean { return !this.disposed && !this.options.signal.aborted && epoch === this.epoch; }

	settingsChanged(): void {
		this.cancel();
		this.failure = undefined;
		const settings = this.options.settings();
		settings.paused = true;
		if (settings.approval) settings.approval.scope = restrictScope(settings.approval.scope, settings.scope, this.source.excluded());
		this.refresh(); this.options.changed();
	}
	async testConnection(): Promise<number> {
		this.tested = undefined;
		const config = { ...this.options.settings() };
		const key = configurationKey(config);
		const epoch = this.epoch;
		const vectors = await this.client.embed(config, ['A quiet library with books.', '在安静的图书馆里阅读。'], this.work.signal, () => this.allowed(epoch));
		if (!this.allowed(epoch) || configurationKey(this.options.settings()) !== key) throw new Error('The connection settings changed. Test again.');
		const dimensions = vectors[0]!.length;
		this.tested = { configuration: key, dimensions };
		this.options.changed();
		return dimensions;
	}
	async pause(): Promise<void> {
		this.options.settings().paused = true; this.cancel(); this.options.changed(); await this.options.save();
	}
	async resume(): Promise<void> {
		const epoch = this.epoch;
		const settings = this.options.settings();
		if (!settings.approval || !this.matches(settings.approval)) throw new Error('Test the connection and build a semantic index first.');
		await this.source.ready();
		await this.load(settings.approval);
		if (!this.allowed(epoch) || !this.matches(settings.approval)) throw new Error('The settings changed. Review them before resuming.');
		this.failure = undefined; settings.paused = false; await this.options.save(); this.refresh();
	}
	private async load(approval: SemanticApproval): Promise<void> {
		const snapshot = await this.source.request({ type: 'semantic-snapshot' }) as VectorSnapshot;
		if (snapshot.needsRebuild || !snapshot.generation || snapshot.space !== approval.space || snapshot.dimensions !== approval.dimensions) {
			throw new Error('The semantic cache is missing or incompatible. Build it manually to send notes again.');
		}
		this.indexer = new SemanticIndexer(this.source, this.client, snapshot, this.options.changed);
	}
	refresh(): void {
		if (this.disposed) return;
		this.dirty = true;
		const settings = this.options.settings();
		if (this.running || this.building || settings.paused || !settings.approval || !this.matches(settings.approval) || this.failure || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.running = this.update().catch((error: unknown) => this.report(error)).finally(() => {
				this.running = undefined; this.options.changed(); if (this.dirty) this.refresh();
			});
		}, 300);
	}
	private async update(): Promise<void> {
		const epoch = this.epoch;
		const signal = this.work.signal;
		const settings = this.options.settings();
		const approval = settings.approval!;
		await this.source.ready();
		if (!this.allowed(epoch) || settings.paused) return;
		if (!this.indexer) await this.load(approval);
		while (this.dirty && this.allowed(epoch) && !settings.paused) {
			this.dirty = false;
			await this.indexer!.synchronize(settings, approval, signal, () => this.allowed(epoch) && !settings.paused);
		}
	}
	private async report(error: unknown): Promise<void> {
		if (this.disposed || (error instanceof EmbeddingError && error.kind === 'cancelled')) return;
		this.failure = error instanceof Error ? error.message : 'Semantic indexing failed. Check the connection and resume.';
		this.options.settings().paused = true;
		this.cancel();
		this.options.changed();
		try { await this.options.save(); }
		catch { this.failure += ' Could not save the paused state. Check vault permissions before reloading.'; this.options.changed(); }
	}
	async build(): Promise<void> {
		if (!this.canBuild || !this.tested) throw new Error('Test the current connection before building the semantic index.');
		this.cancel();
		this.building = true; this.failure = undefined;
		const epoch = this.epoch;
		const signal = this.work.signal;
		const settings = structuredClone(this.options.settings());
		const approval: SemanticApproval = { configuration: this.tested.configuration, dimensions: this.tested.dimensions,
			space: vectorSpace(settings, this.tested.dimensions), scope: restrictScope(settings.scope, settings.scope, this.source.excluded()) };
		let generation: string | undefined;
		try {
			await this.running; await this.source.ready();
			if (!this.allowed(epoch)) throw new EmbeddingError('Remote work stopped.', 'cancelled');
			generation = await this.source.request({ type: 'semantic-begin', space: approval.space, dimensions: approval.dimensions }) as string;
			const indexer = new SemanticIndexer(this.source, this.client, { generation, space: approval.space, dimensions: approval.dimensions, notes: [], needsRebuild: false }, this.options.changed);
			this.options.changed();
			do {
				await this.source.ready();
				await indexer.synchronize(settings, approval, signal, () => this.allowed(epoch));
				if (!this.allowed(epoch)) throw new EmbeddingError('Remote work stopped.', 'cancelled');
			} while (!indexer.complete(approval));
			await this.source.request({ type: 'semantic-commit', generation });
			if (!this.allowed(epoch)) throw new EmbeddingError('Remote work stopped.', 'cancelled');
			this.indexer = indexer;
			this.options.settings().approval = approval; this.options.settings().paused = false;
			await this.options.save();
		} catch (error) {
			if (generation) await this.source.request({ type: 'semantic-abort', generation }).catch(() => { this.failure = 'The search process stopped. Reload before rebuilding the semantic index.'; });
			await this.report(error); throw error;
		} finally { this.building = false; this.options.changed(); this.refresh(); }
	}
	async search(query: string, signal: AbortSignal): Promise<SearchResponse> {
		const plan = parseQuery(query);
		if (!plan.text) throw new Error('Enter text for semantic search. Filters alone do not call the model.');
		const settings = this.options.settings();
		const approval = settings.approval;
		if (!approval || !this.matches(approval) || settings.paused) throw new Error(this.status);
		const epoch = this.epoch;
		const valid = () => this.allowed(epoch) && !settings.paused && this.matches(approval);
		await this.source.ready();
		if (!this.indexer) await this.load(approval);
		const controller = new AbortController();
		const stop = () => controller.abort();
		const work = this.work.signal;
		signal.addEventListener('abort', stop, { once: true }); work.addEventListener('abort', stop, { once: true });
		if (signal.aborted || work.aborted) stop();
		try {
			const vectors = await this.client.embed(settings, [plan.text], controller.signal, valid, approval.dimensions);
			return await retrieveSemantic({ source: this.source, indexed: () => this.indexer!.indexed.values(),
				scope: () => restrictScope(approval.scope, this.options.settings().scope, this.source.excluded()),
				valid: () => valid() && !controller.signal.aborted,
			}, { space: approval.space, vector: vectors[0]!, query });
		} catch (error) {
			if (error instanceof EmbeddingError && error.kind !== 'cancelled' && error.kind !== 'busy') await this.report(error);
			throw error;
		} finally { signal.removeEventListener('abort', stop); work.removeEventListener('abort', stop); }
	}
}

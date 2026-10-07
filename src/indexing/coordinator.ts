import type { SearchClient } from '../runtime/search-client';
import type { NoteState, SearchResponse } from '../search/types';
import { IndexQueue, type NoteSource } from './queue';

export class IndexCoordinator {
	private active?: IndexQueue;
	private staging?: IndexQueue;
	private initialization?: Promise<void>;
	private rebuildTask?: Promise<void>;
	private stopped = false;
	private needsRebuild = false;
	private change = 0;

	constructor(private readonly client: SearchClient, private readonly source: NoteSource, private readonly changed: () => void) {}

	get status(): string {
		if (this.staging) return `Rebuilding · ${this.staging.status}`;
		if (this.needsRebuild) return 'The keyword cache format is incompatible. Select Rebuild index in settings.';
		return this.active?.status ?? 'Starting local search…';
	}

	start(): Promise<void> { return this.initialization ??= this.initialize(); }

	private async initialize(): Promise<void> {
		const snapshot = await this.client.snapshot();
		if (this.stopped) return;
		this.needsRebuild = snapshot.needsRebuild;
		if (!snapshot.needsRebuild) {
			this.active = new IndexQueue(this.client, this.source, this.changed, snapshot.generation, snapshot.notes);
			this.active.reconcile();
		}
		this.changed();
	}

	reconcile(): void { this.change++; this.active?.reconcile(); this.staging?.reconcile(); }
	touch(path: string): void { this.change++; this.active?.touch(path); this.staging?.touch(path); }
	remove(path: string): void { this.change++; this.active?.remove(path); this.staging?.remove(path); }
	rename(oldPath: string, newPath: string): void { this.change++; this.active?.rename(oldPath, newPath); this.staging?.rename(oldPath, newPath); }
	renameDirectory(oldPath: string, newPath: string): void { this.change++; this.active?.renameDirectory(oldPath, newPath); this.staging?.renameDirectory(oldPath, newPath); }
	isCurrent(hit: NoteState): boolean { return this.active?.isCurrent(hit) ?? false; }
	states(): NoteState[] { return (this.active?.states() ?? []).map(({ noteId, path, version }) => ({ noteId, path, version })); }
	async drain(): Promise<void> {
		await this.start();
		if (this.needsRebuild) throw new Error(this.status);
		await this.active?.drain();
	}

	async search(query: string): Promise<SearchResponse> {
		await this.start();
		if (this.needsRebuild) throw new Error(this.status);
		const change = this.change;
		const result = await this.client.search(query, (hit) => this.isCurrent(hit));
		// The UI is refreshed by the same events. Don't expose a count or a truncated
		// page from a query spanning a content change or a generation switch.
		return change === this.change ? result : { hits: [], total: 0 };
	}

	rebuild(): Promise<void> { return this.rebuildTask ??= this.rebuildIndex().finally(() => { this.rebuildTask = undefined; }); }

	private async rebuildIndex(): Promise<void> {
		await this.start();
		const generation = await this.client.request({ type: 'begin-rebuild' }) as string;
		if (this.stopped) return;
		const staging = new IndexQueue(this.client, this.source, this.changed, generation,
			(this.active?.states() ?? []).map((note) => ({ ...note, version: '' })));
		this.staging = staging;
		staging.reconcile();
		try {
			await staging.drain();
			if (this.stopped) return;
			await this.client.request({ type: 'commit-rebuild', generation });
			if (this.stopped) return;
			this.active?.stop();
			this.active = staging;
			this.staging = undefined;
			this.needsRebuild = false;
		} catch (error) {
			staging.stop();
			this.staging = undefined;
			if (!this.stopped) await this.client.request({ type: 'abort-rebuild', generation });
			throw error;
		} finally { this.changed(); }
	}

	stop(): void { this.stopped = true; this.active?.stop(); this.staging?.stop(); this.client.close(); }
}

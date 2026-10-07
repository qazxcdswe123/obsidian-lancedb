import { FileSystemAdapter, MarkdownView, TFile, getFrontMatterInfo, parseYaml } from 'obsidian';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import type LanceSearchPlugin from '../main';
import { contentHash, extractDocument } from '../indexing/document';
import type { SemanticSource } from '../embeddings/indexer';
import { IndexCoordinator } from '../indexing/coordinator';
import { SearchClient } from '../runtime/search-client';
import { deviceId } from '../runtime/device-id';
import { parseQuery } from './query';
import type { SearchHit, SearchResponse } from './types';

export class SearchService {
	private coordinator?: IndexCoordinator;
	private client?: SearchClient;
	private failure?: string;
	private readonly listeners = new Set<() => void>();
	private readonly lifetime = new AbortController();
	private recoveryTimer?: ReturnType<typeof setTimeout>;
	private recoveryAttempts = 0;
	private session = 0;

	constructor(private readonly plugin: LanceSearchPlugin) {
		const { vault } = plugin.app;
		plugin.registerEvent(vault.on('create', (file) => { if (file instanceof TFile) this.coordinator?.touch(file.path); }));
		plugin.registerEvent(vault.on('modify', (file) => { if (file instanceof TFile) this.coordinator?.touch(file.path); }));
		plugin.registerEvent(vault.on('delete', (file) => {
			if (file instanceof TFile) this.coordinator?.remove(file.path);
			else this.coordinator?.reconcile();
		}));
		plugin.registerEvent(vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile) this.coordinator?.rename(oldPath, file.path);
			else this.coordinator?.renameDirectory(oldPath, file.path);
		}));
		plugin.register(() => { clearTimeout(this.recoveryTimer); this.lifetime.abort(); this.coordinator?.stop(); this.listeners.clear(); });
	}

	get signal(): AbortSignal { return this.lifetime.signal; }
	get status(): string { return this.failure ?? this.coordinator?.status ?? 'Open search to build a local keyword index.'; }

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	private changed = () => { for (const listener of this.listeners) listener(); };

	async start(): Promise<void> {
		if (this.lifetime.signal.aborted) throw new Error('Search stopped.');
		if (this.recoveryTimer) throw new Error('Restarting local search…');
		if (!this.coordinator) {
			const { app, manifest } = this.plugin;
			if (!(app.vault.adapter instanceof FileSystemAdapter) || !manifest.dir) throw new Error('The desktop plugin directory is unavailable.');
			const pluginDirectory = join(app.vault.adapter.getBasePath(), manifest.dir);
			const device = deviceId(app);
			const session = ++this.session;
			const client = new SearchClient({
				pluginDirectory, cacheDirectory: join(pluginDirectory, 'cache', `keyword-${device}`),
				version: manifest.version, settings: this.plugin.settings, signal: this.lifetime.signal,
				onFailure: (message, recoverable) => {
					if (session !== this.session || this.lifetime.signal.aborted) return;
					this.failure = message;
					if (recoverable && this.recoveryAttempts < 2) {
						this.recoveryAttempts++;
						this.failure = `Restarting local search (${this.recoveryAttempts}/2)…`;
						this.coordinator?.stop();
						this.coordinator = undefined;
						this.recoveryTimer = setTimeout(() => {
							this.recoveryTimer = undefined;
							this.failure = undefined;
							void this.start().catch((error: unknown) => {
								this.failure = error instanceof Error ? error.message : 'Could not restart local search.';
								this.changed();
							});
						}, this.recoveryAttempts * 500);
					} else if (recoverable) this.failure = 'Search stopped after repeated failures. Check the environment and reload the plugin to retry.';
					this.changed();
				},
			});
			this.client = client;
			this.coordinator = new IndexCoordinator(client, {
				paths: () => app.vault.getMarkdownFiles().map((file) => file.path),
				excludedDirectories: () => this.plugin.settings.excludedDirectories,
				read: (path) => this.readSource(path),
			}, this.changed);
		}
		await this.coordinator.start();
	}

	private async readSource(path: string) {
		const { vault } = this.plugin.app;
		const file = vault.getFileByPath(path);
		if (!file) return null;
		const content = await vault.read(file);
		const info = getFrontMatterInfo(content);
		const parsed: unknown = info.exists ? parseYaml(info.frontmatter) : {};
		if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Frontmatter must be a mapping.');
		return { content, bodyStart: info.exists ? info.contentStart : 0, frontmatter: (parsed ?? {}) as Record<string, unknown> };
	}

	semanticSource(): SemanticSource {
		return {
			ready: async () => { await this.start(); await this.coordinator!.drain(); },
			states: () => this.coordinator?.states() ?? [],
			isCurrent: (note) => this.coordinator?.isCurrent(note) ?? false,
			excluded: () => this.plugin.settings.excludedDirectories,
			request: async (request) => { await this.start(); return await this.client!.request(request); },
			read: async (note) => {
				if (!this.coordinator?.isCurrent(note)) return null;
				const data = await this.readSource(note.path);
				if (!data) return null;
				const document = extractDocument({ ...data, path: note.path, noteId: note.noteId });
				return document.version === note.version && this.coordinator?.isCurrent(note) ? document : null;
			},
		};
	}

	async search(query: string): Promise<SearchResponse> {
		parseQuery(query);
		await this.start();
		if (this.failure) throw new Error(this.failure);
		return await this.coordinator!.search(query);
	}

	async rebuild(): Promise<void> {
		await this.plugin.semantic?.pause();
		await this.start(); await this.coordinator!.rebuild();
	}
	updateScope(): void { this.coordinator?.reconcile(); }
	isCurrent(hit: SearchHit): boolean { return this.coordinator?.isCurrent(hit) ?? false; }

	async openHit(hit: SearchHit): Promise<void> {
		const { app } = this.plugin;
		const file = app.vault.getFileByPath(hit.path);
		if (!file || !this.coordinator?.isCurrent(hit)) throw new Error('This result changed. Search again to open the current note.');
		const leaf = app.workspace.getLeaf(false);
		await leaf.openFile(file);
		if (this.lifetime.signal.aborted) return;
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || view.file !== file) return;
		const content = view.editor.getValue();
		if (!this.coordinator.isCurrent(hit) || contentHash(content) !== hit.sourceHash || hit.end > content.length) {
			throw new Error('The note was opened, but its content changed. Search again for an updated location.');
		}
		const start = view.editor.offsetToPos(hit.start);
		const end = view.editor.offsetToPos(hit.end);
		view.editor.setSelection(start, end);
		view.editor.scrollIntoView({ from: start, to: end }, true);
		view.editor.focus();
	}
}

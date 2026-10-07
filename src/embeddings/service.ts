import { requestUrl } from 'obsidian';
import type LanceSearchPlugin from '../main';
import { EmbeddingClient } from './client';
import { SemanticEngine } from './engine';
import { inScope } from './settings';

export class SemanticService extends SemanticEngine {
	private readonly listeners: Set<() => void>;
	constructor(private readonly plugin: LanceSearchPlugin) {
		const listeners = new Set<() => void>();
		super(plugin.search.semanticSource(), new EmbeddingClient(async (request) => {
			const response = await requestUrl(request);
			let json: unknown;
			try { json = JSON.parse(response.text) as unknown; } catch { json = null; }
			return { status: response.status, json };
		}, (name) => plugin.app.secretStorage.getSecret(name)), {
			settings: () => plugin.settings.embeddings,
			save: () => plugin.saveSettings(), signal: plugin.search.signal,
			changed: () => { for (const listener of listeners) listener(); },
		});
		this.listeners = listeners;
		plugin.register(plugin.search.subscribe(() => this.refresh()));
		plugin.register(() => this.listeners.clear());
		plugin.app.workspace.onLayoutReady(() => this.refresh());
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener); return () => { this.listeners.delete(listener); };
	}
	previewCount(): number {
		return this.plugin.app.vault.getMarkdownFiles().filter((file) => inScope(file.path, this.plugin.settings.embeddings.scope, this.plugin.settings.excludedDirectories)).length;
	}
}

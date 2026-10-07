import { contentHash, isExcluded } from '../indexing/document';
import { normalizeDirectories } from '../utils/directories';

export interface SemanticScope { all: boolean; directories: string[]; excluded: string[] }
export interface EmbeddingConfig {
	baseUrl: string; model: string; secretName: string; dimensions: number | null;
	chunkChars: number; batchSize: number; concurrency: number; timeoutMs: number;
}
export interface SemanticApproval {
	configuration: string; space: string; dimensions: number; scope: SemanticScope;
}
export interface EmbeddingSettings extends EmbeddingConfig {
	scope: SemanticScope; paused: boolean; approval?: SemanticApproval;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function scope(value: unknown): SemanticScope {
	const data = value as Partial<SemanticScope> | null;
	const paths = (items: unknown) => normalizeDirectories(Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string').join('\n') : '');
	return { all: data?.all === true, directories: paths(data?.directories), excluded: paths(data?.excluded) };
}

export function loadEmbeddingSettings(value: unknown): EmbeddingSettings {
	const data = value as Partial<EmbeddingSettings> | null;
	const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
	const settings: EmbeddingSettings = {
		baseUrl: text(data?.baseUrl), model: text(data?.model), secretName: text(data?.secretName),
		dimensions: data?.dimensions == null ? null : integer(data.dimensions, 0, 1, 65536) || null,
		chunkChars: integer(data?.chunkChars, 1200, 200, 8000), batchSize: integer(data?.batchSize, 8, 1, 128),
		concurrency: integer(data?.concurrency, 2, 1, 8), timeoutMs: integer(data?.timeoutMs, 30000, 1000, 120000),
		scope: scope(data?.scope), paused: data?.paused !== false,
	};
	const approved = data?.approval;
	if (approved && /^[a-f0-9]{64}$/.test(approved.configuration) && /^[a-f0-9]{64}$/.test(approved.space)
		&& integer(approved.dimensions, 0, 1, 65536)) {
		settings.approval = { configuration: approved.configuration, space: approved.space, dimensions: approved.dimensions, scope: scope(approved.scope) };
	}
	return settings;
}

export function embeddingUrl(config: EmbeddingConfig): string {
	let url: URL;
	try { url = new URL(config.baseUrl); } catch { throw new Error('Enter a valid embedding API base URL.'); }
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error('Use an HTTP(S) API base URL without credentials, query parameters, or a fragment.');
	}
	if (!config.model.trim()) throw new Error('Enter an embedding model ID.');
	if (!config.secretName.trim()) throw new Error('Select an API key from secret storage.');
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/embeddings`;
	return url.href;
}

export function configurationKey(config: EmbeddingConfig): string {
	return contentHash(JSON.stringify([embeddingUrl(config), config.model, config.dimensions, config.chunkChars, 1]));
}
export function vectorSpace(config: EmbeddingConfig, dimensions: number): string {
	return contentHash(JSON.stringify([embeddingUrl(config), config.model, dimensions, config.chunkChars, 1]));
}
export function inScope(path: string, selection: SemanticScope, localExcluded: string[]): boolean {
	return /\.md$/i.test(path) && (selection.all || isExcluded(path, selection.directories))
		&& !isExcluded(path, [...selection.excluded, ...localExcluded]);
}

export function restrictScope(approved: SemanticScope, selected: SemanticScope, localExcluded: string[]): SemanticScope {
	const directories = approved.all ? selected.directories : selected.all ? approved.directories
		: approved.directories.flatMap((a) => selected.directories.flatMap((b) =>
			isExcluded(a, [b]) ? [a] : isExcluded(b, [a]) ? [b] : []));
	return { all: approved.all && selected.all, directories: [...new Set(directories)],
		excluded: [...new Set([...approved.excluded, ...selected.excluded, ...localExcluded])] };
}

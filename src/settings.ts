import { loadEmbeddingSettings, type EmbeddingSettings } from './embeddings/settings';
import { normalizeDirectories } from './utils/directories';
export { normalizeDirectories } from './utils/directories';

export interface RuntimeSettings {
	nodePath: string;
	globalModulesPath: string;
}

export interface PluginSettings extends RuntimeSettings {
	excludedDirectories: string[];
	embeddings: EmbeddingSettings;
}

export function loadSettings(data: unknown): PluginSettings {
	const values = data as Partial<PluginSettings> | null;
	return {
		nodePath: typeof values?.nodePath === 'string' ? values.nodePath.trim() : '',
		globalModulesPath: typeof values?.globalModulesPath === 'string' ? values.globalModulesPath.trim() : '',
		embeddings: loadEmbeddingSettings(values?.embeddings),
		excludedDirectories: Array.isArray(values?.excludedDirectories)
			? normalizeDirectories(values.excludedDirectories.filter((path) => typeof path === 'string').join('\n')) : [],
	};
}

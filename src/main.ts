import { Notice, Plugin } from 'obsidian';
import { RuntimeCheckModal } from './ui/runtime-check-modal';
import { loadSettings, type PluginSettings } from './settings';
import { RuntimeSettingTab } from './ui/runtime-setting-tab';
import { SearchService } from './search/service';
import { SearchModal } from './ui/search-modal';
import { SemanticService } from './embeddings/service';

export default class LanceSearchPlugin extends Plugin {
	settings!: PluginSettings;
	search!: SearchService;
	semantic!: SemanticService;

	async onload(): Promise<void> {
		this.settings = loadSettings(await this.loadData());
		this.search = new SearchService(this);
		this.semantic = new SemanticService(this);
		const lifetime = new AbortController();
		this.register(() => lifetime.abort());
		const check = () => new RuntimeCheckModal(this.app, this, lifetime.signal).open();
		this.addCommand({
			id: 'check-search-runtime',
			name: 'Check search runtime',
			callback: check,
		});
		this.addSettingTab(new RuntimeSettingTab(this.app, this, check));
		let searchModal: SearchModal | undefined;
		this.addCommand({ id: 'search-notes', name: 'Search notes', callback: () => {
			searchModal?.close();
			searchModal = new SearchModal(this.app, this.search, this.semantic);
			searchModal.open();
		} });
		this.addCommand({ id: 'rebuild-keyword-index', name: 'Rebuild keyword index', callback: () => {
			void this.search.rebuild().then(() => new Notice('Keyword index rebuilt.'))
				.catch((error: unknown) => new Notice(error instanceof Error ? error.message : 'Could not rebuild the index.'));
		} });
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type LanceSearchPlugin from '../main';
import { normalizeDirectories } from '../settings';
import { renderEmbeddingSettings } from './embedding-settings';

export class RuntimeSettingTab extends PluginSettingTab {
	private unsubscribe?: () => void;
	constructor(app: App, private readonly plugin: LanceSearchPlugin, private readonly check: () => void) {
		super(app, plugin);
		plugin.register(() => this.hide());
	}

	display(): void {
		this.unsubscribe?.();
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('p', { text: 'Keyword search stays entirely in your vault. Remote semantic search below is optional.' });
		new Setting(containerEl)
			.setName('Excluded directories')
			.setDesc('One vault-relative directory per line. Excludes that directory and its children from local search.')
			.addTextArea((text) => text.setPlaceholder('Private\narchive').setValue(this.plugin.settings.excludedDirectories.join('\n')).onChange(async (value) => {
				this.plugin.settings.excludedDirectories = normalizeDirectories(value);
				this.plugin.search.updateScope();
				this.plugin.semantic.settingsChanged();
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName('Keyword index')
			.setDesc('Builds a fresh local index, then switches when ready. Search, Markdown, and settings are preserved.')
			.addButton((button) => button.setButtonText('Rebuild index').onClick(async () => {
				button.setDisabled(true);
				try { await this.plugin.search.rebuild(); new Notice('Keyword index rebuilt.'); }
				catch (error) { new Notice(error instanceof Error ? error.message : 'Could not rebuild the index.'); }
				finally { button.setDisabled(false); }
			}));
		containerEl.createEl('p', { text: 'Install Node.js with npm, then run this command in a terminal:' });
		containerEl.createEl('pre', { text: 'npm install -g @lancedb/lancedb@latest' });
		new Setting(containerEl)
			.setName('Node.js executable')
			.setDesc('Leave empty to detect automatically, or enter the absolute path from command -v node. Reload the plugin after changing runtime paths.')
			.addText((text) => text.setPlaceholder('Detect automatically').setValue(this.plugin.settings.nodePath).onChange(async (value) => {
				this.plugin.settings.nodePath = value.trim();
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName('Global modules directory')
			.setDesc('Leave empty to use npm root -g. For a custom installation, enter the absolute path printed by that command.')
			.addText((text) => text.setPlaceholder('Detect automatically').setValue(this.plugin.settings.globalModulesPath).onChange(async (value) => {
				this.plugin.settings.globalModulesPath = value.trim();
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName('Check environment')
			.setDesc('Verify the installed global version with built-in sample text. No notes are read or sent.')
			.addButton((button) => button.setButtonText('Check environment').onClick(this.check));
		this.unsubscribe = renderEmbeddingSettings(containerEl, this.plugin);
	}

	hide(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
}

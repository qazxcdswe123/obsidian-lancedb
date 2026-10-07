import { App, Modal, Notice, SecretComponent, Setting } from 'obsidian';
import type LanceSearchPlugin from '../main';
import { normalizeDirectories } from '../settings';

class SemanticBuildModal extends Modal {
	private readonly scopeSnapshot: string;
	private readonly unload = () => this.close();
	constructor(app: App, private readonly plugin: LanceSearchPlugin) {
		super(app); this.scopeSnapshot = JSON.stringify([plugin.settings.embeddings.scope, plugin.settings.excludedDirectories]);
	}
	onOpen(): void {
		this.plugin.search.signal.addEventListener('abort', this.unload, { once: true });
		this.setTitle('Build semantic index');
		const config = this.plugin.settings.embeddings;
		this.contentEl.createEl('p', { text: `Send body passages and body headings from ${this.plugin.semantic.previewCount()} currently selected notes to ${config.baseUrl}, using model ${config.model}. New and changed notes in this scope will update automatically after building.` });
		this.contentEl.createEl('p', { text: 'Filenames, paths, tags, and frontmatter are not added to requests. Body text may itself contain private information. Your provider may charge for these requests. Building again regenerates every selected passage.' });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) => button.setButtonText('Start sending and build').setCta().onClick(async () => {
				if (this.scopeSnapshot !== JSON.stringify([this.plugin.settings.embeddings.scope, this.plugin.settings.excludedDirectories])) {
					new Notice('The selected scope changed. Open the build preview again.'); this.close(); return;
				}
				this.close();
				try { await this.plugin.semantic.build(); new Notice('Semantic index built.'); }
				catch (error) { new Notice(error instanceof Error ? error.message : 'Could not build the semantic index.'); }
			}));
	}
	onClose(): void { this.plugin.search.signal.removeEventListener('abort', this.unload); this.contentEl.empty(); }
}

export function renderEmbeddingSettings(container: HTMLElement, plugin: LanceSearchPlugin): () => void {
	const config = plugin.settings.embeddings;
	new Setting(container).setName('Remote semantic search').setHeading();
	container.createEl('p', { text: 'Optional. Send selected body passages to your embedding provider. Keyword search stays local. Saving settings pauses remote work; testing sends only two built-in public sentences. Building the index enables automatic updates for the selected scope.' });
	const status = container.createEl('p', { cls: 'lancedb-search-status', attr: { role: 'status' } });
	const save = async () => { plugin.semantic.settingsChanged(); await plugin.saveSettings(); };
	for (const [key, name, description, placeholder] of [
		['baseUrl', 'API base URL', 'Include the API version path. The plugin appends /embeddings. Use HTTPS for remote providers.', 'https://api.example.com/v1'],
		['model', 'Model ID', 'Use an embedding model supported by your provider.', ''],
	] as const) {
		new Setting(container).setName(name).setDesc(description).addText((text) => text.setPlaceholder(placeholder).setValue(config[key]).onChange(async (value) => { config[key] = value.trim(); await save(); }));
	}
	const keySetting = new Setting(container).setName('API key').setDesc('Choose or create a secret in Obsidian. Plugin settings store only its name.');
	new SecretComponent(plugin.app, keySetting.controlEl).setValue(config.secretName).onChange(async (value) => { config.secretName = value; await save(); });
	new Setting(container).setName('Dimensions').setDesc('Optional. Leave empty unless your provider supports requesting a specific dimension.').addText((text) => {
		text.inputEl.type = 'number'; text.inputEl.min = '1'; text.inputEl.max = '65536';
		text.setValue(config.dimensions?.toString() ?? '').onChange(async (value) => {
			const number = value ? Number(value) : null;
			if (number !== null && (!Number.isInteger(number) || number < 1 || number > 65536)) return;
			config.dimensions = number; await save();
		});
	});
	for (const [key, name, description, min, max] of [
		['chunkChars', 'Passage length', 'Maximum body characters per passage, plus up to 600 characters of body headings. Adjust to your model input limit.', 200, 8000],
		['batchSize', 'Batch size', 'Maximum passages in one request. Adjust to your provider limits.', 1, 128],
		['concurrency', 'Concurrent requests', 'Maximum active requests, including searches and requests that have timed out locally.', 1, 8],
		['timeoutMs', 'Request timeout', 'Milliseconds to wait. A timed-out request may still be running remotely.', 1000, 120000],
	] as const) {
		new Setting(container).setName(name).setDesc(description).addText((text) => {
			text.inputEl.type = 'number'; text.inputEl.min = String(min); text.inputEl.max = String(max);
			text.setValue(String(config[key])).onChange(async (value) => {
				const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) return;
				config[key] = number; await save();
			});
		});
	}
	new Setting(container).setName('Include all Markdown').setDesc('Otherwise, select directories below. Local search exclusions always apply.').addToggle((toggle) => toggle.setValue(config.scope.all).onChange(async (value) => { config.scope.all = value; await save(); }));
	for (const [key, name, description] of [
		['directories', 'Included directories', 'One vault-relative directory per line. Used when Include all Markdown is off.'],
		['excluded', 'Semantic exclusions', 'Additional directories to keep out of remote requests.'],
	] as const) {
		new Setting(container).setName(name).setDesc(description).addTextArea((text) => text.setValue(config.scope[key].join('\n')).onChange(async (value) => { config.scope[key] = normalizeDirectories(value); await save(); }));
	}
	container.createEl('p', { text: 'Build the semantic index again to expand its scope. Resume uses only the previously approved scope. Model or passage length changes require a new connection test and build.' });
	let testing = false;
	let buildButton: { setDisabled(value: boolean): unknown };
	new Setting(container).setName('Connection and index')
		.addButton((button) => button.setButtonText('Test connection').onClick(async () => {
			if (testing) return; testing = true; button.setDisabled(true);
			try { const dimensions = await plugin.semantic.testConnection(); new Notice(`Connection verified: ${dimensions} dimensions. No notes sent.`); }
			catch (error) { new Notice(error instanceof Error ? error.message : 'The connection test failed.'); }
			finally { testing = false; button.setDisabled(false); }
		}))
		.addButton((button) => { buildButton = button; button.setButtonText('Build semantic index').onClick(() => new SemanticBuildModal(plugin.app, plugin).open()); });
	new Setting(container).setName('Remote calls')
		.addButton((button) => button.setButtonText('Pause').onClick(() => plugin.semantic.pause()))
		.addButton((button) => button.setButtonText('Resume').onClick(async () => {
			try { await plugin.semantic.resume(); }
			catch (error) { new Notice(error instanceof Error ? error.message : 'Could not resume semantic indexing.'); }
		}));
	const update = () => { status.setText(plugin.semantic.status); buildButton.setDisabled(!plugin.semantic.canBuild); };
	update(); return plugin.semantic.subscribe(update);
}

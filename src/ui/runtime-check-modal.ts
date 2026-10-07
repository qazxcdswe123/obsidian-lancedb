import { App, FileSystemAdapter, Modal, Setting } from 'obsidian';
import { join } from 'node:path';
import { resolveGlobalRuntime } from '../runtime/global-runtime';
import { runNativeProbe } from '../runtime/native-probe';
import type LanceSearchPlugin from '../main';

export class RuntimeCheckModal extends Modal {
	private readonly lifetime = new AbortController();
	private readonly closeOnUnload = () => { this.close(); };

	constructor(app: App, private readonly plugin: LanceSearchPlugin, private readonly pluginLifetime: AbortSignal) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Check search runtime');
		this.pluginLifetime.addEventListener('abort', this.closeOnUnload, { once: true });
		if (this.pluginLifetime.aborted) {
			this.close();
			return;
		}
		void this.inspect().catch((error: unknown) => {
			if (!this.lifetime.signal.aborted) this.contentEl.setText(error instanceof Error ? error.message : 'Could not inspect the search runtime.');
		});
	}

	private async inspect(): Promise<void> {
		const report = await resolveGlobalRuntime(this.plugin.settings, this.lifetime.signal);
		if (this.lifetime.signal.aborted) return;
		this.contentEl.createEl('p', { text: `Found global LanceDB ${report.sdkVersion} with Node.js ${report.nodeVersion}.` });
		this.contentEl.createEl('pre', { text: JSON.stringify(report, null, 2) });
		this.contentEl.createEl('p', {
			text: 'Run a local check using built-in sample text. No notes are read or sent. Temporary test data is removed after the check.',
		});
		new Setting(this.contentEl).addButton((button) => button.setButtonText('Check native search').onClick(async () => {
			button.setDisabled(true);
			const output = this.contentEl.createEl('p', { text: 'Checking…' });
			try {
				const adapter = this.app.vault.adapter;
				if (!(adapter instanceof FileSystemAdapter) || !this.plugin.manifest.dir) {
					throw new Error('The installed desktop plugin directory is unavailable.');
				}
				const directory = join(adapter.getBasePath(), this.plugin.manifest.dir);
				const result = await runNativeProbe({
					pluginDirectory: directory, cacheDirectory: join(directory, 'cache', 'm0'),
					version: this.plugin.manifest.version, settings: this.plugin.settings, signal: this.lifetime.signal,
				});
				if (!this.lifetime.signal.aborted) output.setText(JSON.stringify(result, null, 2));
			} catch (error) {
				if (!this.lifetime.signal.aborted) output.setText(error instanceof Error ? error.message : 'Runtime check failed.');
			} finally {
				button.setDisabled(false);
			}
		}));
	}

	onClose(): void {
		this.lifetime.abort();
		this.pluginLifetime.removeEventListener('abort', this.closeOnUnload);
		this.contentEl.empty();
	}
}

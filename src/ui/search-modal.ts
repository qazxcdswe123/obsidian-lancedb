import { App, Modal, Notice } from 'obsidian';
import type { SearchService } from '../search/service';
import type { SearchHit } from '../search/types';
import type { SemanticService } from '../embeddings/service';
import { fuseResults } from '../search/fusion';

export class SearchModal extends Modal {
	private input!: HTMLInputElement;
	private statusEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private queryId = 0;
	private timer?: number;
	private unsubscribe?: () => void;
	private unsubscribeSemantic?: () => void;
	private mode: 'keyword' | 'semantic' | 'hybrid' = 'keyword';
	private request?: AbortController;
	private helpEl!: HTMLElement;
	private submit!: HTMLButtonElement;
	private closed = false;
	private hits: SearchHit[] = [];
	private selected = 0;
	private querying = false;
	private refreshPending = false;
	private modalWindow!: Window;
	private readonly closeOnUnload = () => { this.close(); };

	constructor(app: App, private readonly service: SearchService, private readonly semantic: SemanticService) {
		super(app);
		this.scope.register([], 'Enter', () => {
			if (this.mode !== 'keyword' && this.input?.ownerDocument.activeElement === this.input) {
				void this.runQuery(); return false;
			}
			const hit = this.hits[this.selected];
			if (hit) void this.openResult(hit);
			return false;
		});
		for (const [key, delta] of [['ArrowDown', 1], ['ArrowUp', -1]] as const) {
			this.scope.register([], key, () => {
				if (this.hits.length) {
					this.selected = (this.selected + delta + this.hits.length) % this.hits.length;
					this.updateSelection();
				}
				return false;
			});
		}
	}

	onOpen(): void {
		this.setTitle('Search notes');
		this.modalWindow = this.contentEl.ownerDocument.defaultView!;
		this.contentEl.addClass('lancedb-search');
		const controls = this.contentEl.createDiv({ cls: 'lancedb-search-controls' });
		const mode = controls.createEl('select', { attr: { 'aria-label': 'Search mode' } });
		for (const [value, text] of [['keyword', 'Keyword'], ['semantic', 'Semantic'], ['hybrid', 'Hybrid']]) mode.createEl('option', { value, text });
		mode.addEventListener('change', () => {
			this.mode = mode.value as typeof this.mode;
			this.submit.hidden = this.mode === 'keyword';
			this.helpEl.setText(this.mode === 'keyword' ? 'All words must match. Use "exact phrase", path:folder or tag:topic.'
				: 'Press Enter or select Search to send query text to your embedding provider. Path and tag filters stay local. Semantic matches need not contain the exact words.');
			this.onInput();
		});
		this.submit = controls.createEl('button', { text: 'Search', attr: { type: 'button' } });
		this.submit.hidden = true;
		this.submit.addEventListener('click', () => { void this.runQuery(); });
		this.input = this.contentEl.createEl('input', { type: 'search', placeholder: 'Search notes…', attr: { 'aria-label': 'Search notes' } });
		this.helpEl = this.contentEl.createEl('p', { cls: 'lancedb-search-help', text: 'All words must match. Use "exact phrase", path:folder or tag:topic.' });
		this.statusEl = this.contentEl.createDiv({ cls: 'lancedb-search-status', attr: { role: 'status', 'aria-live': 'polite' } });
		this.resultsEl = this.contentEl.createDiv({ cls: 'lancedb-search-results' });
		this.input.addEventListener('input', this.onInput);
		this.unsubscribe = this.service.subscribe(this.onIndexChanged);
		this.unsubscribeSemantic = this.semantic.subscribe(this.onSemanticChanged);
		this.service.signal.addEventListener('abort', this.closeOnUnload, { once: true });
		if (this.service.signal.aborted) { this.close(); return; }
		this.statusEl.setText(this.service.status);
		void this.service.start().catch((error: unknown) => { if (!this.closed) this.showError(error); });
		this.input.focus();
	}

	private onInput = () => {
		this.request?.abort();
		this.queryId++;
		this.hits = [];
		this.resultsEl.empty();
		this.modalWindow.clearTimeout(this.timer);
		this.timer = undefined;
		if (this.mode === 'keyword') this.scheduleQuery();
		else this.statusEl.setText(this.semantic.status);
	};

	private onSemanticChanged = () => {
		if (!this.closed && this.mode !== 'keyword') this.statusEl.setText(this.semantic.status);
	};

	private onIndexChanged = () => {
		if (this.closed) return;
		if (this.mode !== 'keyword') { this.onSemanticChanged(); return; }
		this.statusEl.setText(this.service.status);
		// Continuous indexing must neither postpone user input forever nor queue
		// overlapping queries faster than the backend can finish them.
		if (this.querying) this.refreshPending = true;
		else this.scheduleQuery();
	};

	private scheduleQuery(): void {
		if (this.timer !== undefined || this.closed || this.mode !== 'keyword') return;
		this.timer = this.modalWindow.setTimeout(() => { this.timer = undefined; void this.runQuery(); }, 150);
	}

	private async runQuery(): Promise<void> {
		if (this.querying) { this.refreshPending = this.mode === 'keyword'; return; }
		const id = ++this.queryId;
		const query = this.input.value.trim();
		if (!query || this.closed) { this.resultsEl.empty(); this.statusEl.setText(this.service.status); return; }
		this.querying = true;
		this.submit.disabled = true;
		this.request = new AbortController();
		const mode = this.mode;
		try {
			const result = mode === 'keyword' ? await this.service.search(query)
				: mode === 'semantic' ? await this.semantic.search(query, this.request.signal)
					: await Promise.all([this.service.search(query), this.semantic.search(query, this.request.signal)])
						.then(([keyword, semantic]) => fuseResults(keyword, semantic));
			if (this.closed || id !== this.queryId) return;
			this.hits = result.hits.filter((hit) => this.service.isCurrent(hit));
			this.selected = 0;
			this.resultsEl.empty();
			this.statusEl.setText(`${result.total}${mode === 'keyword' ? '' : ' candidate'} results${result.total > 50 ? ' · showing 50' : ''} · ${mode === 'keyword' ? this.service.status : this.semantic.status}`);
			for (const [index, hit] of this.hits.entries()) {
				const button = this.resultsEl.createEl('button', { cls: 'lancedb-search-result', attr: { type: 'button' } });
				button.createDiv({ cls: 'lancedb-search-title', text: hit.title });
				button.createDiv({ cls: 'lancedb-search-path', text: hit.path });
				button.createDiv({ cls: 'lancedb-search-snippet', text: hit.snippet });
				button.addEventListener('click', () => { void this.openResult(hit); });
				button.addEventListener('focus', () => { this.selected = index; this.updateSelection(); });
			}
			this.updateSelection();
		} catch (error) { if (!this.closed && id === this.queryId) this.showError(error); }
		finally {
			this.querying = false;
			this.submit.disabled = false;
			if (this.refreshPending) { this.refreshPending = false; this.scheduleQuery(); }
		}
	}

	private updateSelection(): void {
		Array.from(this.resultsEl.children).forEach((element, index) => {
			element.toggleClass('is-selected', index === this.selected);
			if (index === this.selected) element.scrollIntoView({ block: 'nearest' });
		});
	}

	private showError(error: unknown): void {
		this.hits = [];
		this.resultsEl.empty();
		this.statusEl.setText(error instanceof Error ? error.message : 'Search failed.');
	}

	private async openResult(hit: SearchHit): Promise<void> {
		try { await this.service.openHit(hit); this.close(); }
		catch (error) { new Notice(error instanceof Error ? error.message : 'Could not open the result.'); }
	}

	onClose(): void {
		this.closed = true;
		this.request?.abort();
		this.queryId++;
		this.modalWindow?.clearTimeout(this.timer);
		this.unsubscribe?.();
		this.unsubscribeSemantic?.();
		this.service.signal.removeEventListener('abort', this.closeOnUnload);
		this.input?.removeEventListener('input', this.onInput);
		this.contentEl.empty();
	}
}

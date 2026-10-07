import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import { extractDocument, isExcluded } from './document';
import type { SearchClient } from '../runtime/search-client';
import type { NoteDocument, NoteState } from '../search/types';

interface IndexedNote extends NoteState {
	revision: number;
	indexedVersion: string;
}

export interface NoteSource {
	paths(): string[];
	read(path: string): Promise<{ content: string; bodyStart: number; frontmatter: Record<string, unknown> } | null>;
	excludedDirectories(): string[];
}

export class IndexQueue {
	private readonly notes = new Map<string, IndexedNote>();
	private readonly pending = new Set<string>();
	private readonly removed = new Set<string>();
	private readonly errors = new Set<string>();
	private running?: Promise<void>;
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private failure?: string;

	private batching = false;
	constructor(private readonly client: SearchClient, private readonly source: NoteSource, private readonly changed: () => void,
		readonly generation: string, snapshot: NoteState[]) {
		for (const note of snapshot) this.notes.set(note.path, { ...note, revision: 0, indexedVersion: note.version });
	}

	states(): NoteState[] { return [...this.notes.values()]; }
	async drain(): Promise<void> {
		clearTimeout(this.timer);
		await this.running;
		if (this.pending.size || this.removed.size) await this.run();
		if (this.failure || this.errors.size) throw new Error(this.status);
	}

	private run(): Promise<void> {
		return this.running ??= this.flush().catch(() => {
			if (!this.stopped) this.failure = 'Keyword indexing failed. Check the environment and rebuild the index to retry.';
		}).finally(() => { this.running = undefined; this.changed(); });
	}

	get status(): string {
		if (this.failure) return this.failure;
		if (this.errors.size) return `${this.errors.size} notes could not be read. Fix their frontmatter or rebuild to retry.`;
		if (this.running || this.pending.size || this.removed.size) return `Indexing… ${this.validCount} notes ready`;
		return `${this.notes.size} notes indexed locally`;
	}

	private get validCount(): number { return [...this.notes.values()].filter((note) => note.version).length; }

	reconcile(): void {
		if (this.stopped) return;
		this.batching = true;
		const paths = new Set(this.source.paths().filter((path) => !isExcluded(path, this.source.excludedDirectories())));
		for (const path of this.notes.keys()) if (!paths.has(path)) this.remove(path);
		for (const path of paths) this.touch(path);
		this.batching = false;
		this.schedule(0);
	}

	touch(path: string): void {
		if (this.stopped) return;
		if (isExcluded(path, this.source.excludedDirectories()) || !/\.md$/i.test(path)) { this.remove(path); return; }
		let note = this.notes.get(path);
		if (!note) {
			note = { noteId: randomUUID(), path, version: '', indexedVersion: '', revision: 0 };
			this.notes.set(path, note);
		}
		note.version = '';
		note.revision++;
		this.pending.add(path);
		this.schedule(250);
	}

	remove(path: string): void {
		const note = this.notes.get(path);
		if (!note) return;
		this.notes.delete(path);
		this.pending.delete(path);
		this.errors.delete(path);
		this.removed.add(note.noteId);
		this.schedule(250);
	}

	rename(oldPath: string, newPath: string): void {
		const note = this.notes.get(oldPath);
		if (!note || isExcluded(newPath, this.source.excludedDirectories()) || !/\.md$/i.test(newPath)) {
			this.remove(oldPath); this.touch(newPath); return;
		}
		this.notes.delete(oldPath);
		this.pending.delete(oldPath);
		this.errors.delete(oldPath);
		note.path = newPath;
		this.notes.set(newPath, note);
		this.touch(newPath);
	}

	renameDirectory(oldPath: string, newPath: string): void {
		for (const path of [...this.notes.keys()]) {
			if (path.startsWith(`${oldPath}/`)) this.rename(path, `${newPath}${path.slice(oldPath.length)}`);
		}
	}

	private schedule(delay: number): void {
		if (this.stopped || this.batching) return;
		clearTimeout(this.timer);
		// Indexing must keep up with saves even when the main window is hidden by a popout.
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.run();
			this.changed();
		}, delay);
		this.changed();
	}

	private async flush(): Promise<void> {
		while (!this.stopped && (this.pending.size || this.removed.size)) {
			const paths = [...this.pending].slice(0, 32);
			for (const path of paths) this.pending.delete(path);
			const removed = [...this.removed];
			this.removed.clear();
			const documents: { document: NoteDocument; note: IndexedNote; revision: number }[] = [];
			for (const path of paths) {
				const note = this.notes.get(path);
				if (!note) continue;
				const revision = note.revision;
				try {
					const data = await this.source.read(path);
					if (this.stopped) return;
					if (this.notes.get(path) !== note || note.revision !== revision) continue;
					if (!data) { this.remove(path); continue; }
					const document = extractDocument({ ...data, path, noteId: note.noteId });
					this.errors.delete(path);
					if (document.version === note.indexedVersion) note.version = document.version;
					else documents.push({ document, note, revision });
				} catch { if (!this.stopped && this.notes.get(path) === note) this.errors.add(path); }
			}
			if (this.stopped) return;
			const ready = documents.filter(({ note, revision }) => this.notes.get(note.path) === note && note.revision === revision);
			if (ready.length || removed.length) {
				await this.client.request({ type: 'apply', generation: this.generation, notes: ready.map((item) => item.document), removed });
				for (const { document, note, revision } of ready) {
					// An edit/delete/rename received during the write invalidates the old response.
					if (this.notes.get(note.path) === note) {
						note.indexedVersion = document.version;
						if (note.revision === revision) note.version = document.version;
					}
				}
			}
			this.changed();
			if (!this.pending.size && !this.removed.size) await this.client.request({ type: 'maintain', generation: this.generation });
		}
	}

	isCurrent(hit: NoteState): boolean {
		const note = this.notes.get(hit.path);
		return !this.stopped && !!note?.version && note.noteId === hit.noteId && note.version === hit.version;
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
	}
}

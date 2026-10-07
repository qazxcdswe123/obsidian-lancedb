import type { NoteDocument, NoteState, SearchReply, SearchRequest } from '../search/types';
import { chunkNote } from './chunks';
import { EmbeddingClient, EmbeddingError } from './client';
import type { CachedVector, EmbeddedChunk, VectorSnapshot } from './types';
import { inScope, type EmbeddingConfig, type SemanticApproval } from './settings';

export interface SemanticSource {
	ready(): Promise<void>;
	states(): NoteState[];
	isCurrent(note: NoteState): boolean;
	read(note: NoteState): Promise<NoteDocument | null>;
	request(request: SearchRequest): Promise<SearchReply['result']>;
	excluded(): string[];
}

export class SemanticIndexer {
	readonly indexed = new Map<string, NoteState>();
	constructor(private readonly source: SemanticSource, private readonly client: EmbeddingClient,
		readonly snapshot: VectorSnapshot, private readonly changed: () => void) {
		for (const note of snapshot.notes) this.indexed.set(note.noteId, note);
	}

	async synchronize(config: EmbeddingConfig, approval: SemanticApproval, signal: AbortSignal, current: () => boolean): Promise<void> {
		const eligible = (note: NoteState) => inScope(note.path, approval.scope, this.source.excluded());
		const states = this.source.states().filter(eligible);
		const present = new Set(states.map((note) => note.noteId));
		const removed = [...this.indexed.keys()].filter((id) => !present.has(id));
		if (signal.aborted || !current()) return;
		if (removed.length) {
			await this.source.request({ type: 'semantic-remove', generation: this.snapshot.generation, noteIds: removed });
			for (const id of removed) this.indexed.delete(id);
		}
		for (const note of states) {
			if (signal.aborted || !current()) return;
			if (!note.version || this.indexed.get(note.noteId)?.version === note.version) continue;
			const valid = () => current() && this.source.isCurrent(note) && eligible(note);
			let document: NoteDocument | null;
			try { document = await this.source.read(note); }
			catch { throw new Error('A selected note could not be read. Check its frontmatter and resume.'); }
			if (!document || !valid() || signal.aborted) continue;
			const chunks = chunkNote(document, config.chunkChars);
			const cached = await this.source.request({ type: 'semantic-vectors', generation: this.snapshot.generation, noteId: note.noteId }) as CachedVector[];
			const vectors = new Map(cached.map((row) => [row.inputHash, row.vector]));
			const missing = [...new Map(chunks.filter((chunk) => !vectors.has(chunk.inputHash)).map((chunk) => [chunk.inputHash, chunk])).values()];
			try {
				for (let from = 0; from < missing.length; from += config.batchSize) {
					const batch = missing.slice(from, from + config.batchSize);
					const embedded = await this.client.embed(config, batch.map((chunk) => chunk.input), signal, valid, approval.dimensions);
					batch.forEach((chunk, i) => { vectors.set(chunk.inputHash, embedded[i]!); });
				}
			} catch (error) {
				if (error instanceof EmbeddingError && error.kind === 'cancelled') continue;
				throw error;
			}
			if (!valid() || signal.aborted) continue;
			const embedded: EmbeddedChunk[] = chunks.map(({ input: _input, ...chunk }) => ({ ...chunk, vector: vectors.get(chunk.inputHash)! }));
			await this.source.request({ type: 'semantic-apply', generation: this.snapshot.generation,
				note: { noteId: document.noteId, path: document.path, version: document.version, sourceHash: document.sourceHash, title: document.title, tags: document.tags }, chunks: embedded });
			this.indexed.set(note.noteId, { ...note });
			this.changed();
		}
	}
	complete(approval: SemanticApproval): boolean {
		return this.source.states().filter((note) => inScope(note.path, approval.scope, this.source.excluded()))
			.every((note) => !!note.version && this.indexed.get(note.noteId)?.version === note.version);
	}
}

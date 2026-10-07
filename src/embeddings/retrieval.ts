import type { NoteState, SearchHit, SearchResponse } from '../search/types';
import type { SemanticSource } from './indexer';
import type { SemanticScope } from './settings';
import { inScope } from './settings';

interface RetrievalOptions {
	source: SemanticSource;
	indexed(): Iterable<NoteState>;
	scope(): SemanticScope;
	valid(): boolean;
}

export async function retrieveSemantic(options: RetrievalOptions, query: { space: string; vector: number[]; query: string }): Promise<SearchResponse> {
	const { source } = options;
	const excluded = new Set<string>();
	const hits: SearchHit[] = [];
	const accepted = (hit: NoteState) => source.isCurrent(hit) && inScope(hit.path, options.scope(), source.excluded());
	// Bound work to four batches of 200 chunks. Excluding whole notes on refill
	// prevents one long note or stale results from occupying every slot.
	for (let batch = 0; batch < 4 && hits.filter(accepted).length < 50; batch++) {
		if (!options.valid()) return { hits: [], total: 0 };
		for (const note of options.indexed()) if (!source.isCurrent(note)) excluded.add(note.noteId);
		const result = await source.request({ type: 'semantic-search', ...query, scope: options.scope(), excludeNoteIds: [...excluded] }) as SearchHit[];
		if (!options.valid()) return { hits: [], total: 0 };
		for (const hit of result) {
			if (!excluded.has(hit.noteId) && accepted(hit)) hits.push(hit);
			excluded.add(hit.noteId);
		}
		if (!result.length) break;
	}
	const current = hits.filter(accepted).sort((a, b) => b.score - a.score).slice(0, 50);
	return { hits: current, total: current.length };
}

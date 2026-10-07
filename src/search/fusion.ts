import type { SearchHit, SearchResponse } from './types';

export function fuseResults(keyword: SearchResponse, semantic: SearchResponse): SearchResponse {
	const hits = new Map<string, SearchHit>();
	for (const result of [keyword, semantic]) {
		result.hits.forEach((hit, rank) => {
			const previous = hits.get(hit.noteId);
			// Reciprocal rank fusion combines ranks, never BM25 and cosine units.
			hits.set(hit.noteId, { ...(previous ?? hit), score: (previous?.score ?? 0) + 1 / (60 + rank + 1) });
		});
	}
	const ordered = [...hits.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return { hits: ordered.slice(0, 50), total: ordered.length };
}

import type { Table, VectorQuery } from '@lancedb/lancedb';
import type { SemanticScope } from '../embeddings/settings';
import type { SemanticRequest } from '../embeddings/types';
import { parseQuery, queryFilter, sqlString } from '../search/query';
import { ANN_CHUNK_LIMIT, ANN_PROBES } from './vector-config';

export type SemanticSearch = Extract<SemanticRequest, { type: 'semantic-search' }>;

function pathsFilter(paths: string[]): string {
	return paths.map((path) => `(path = ${sqlString(path)} OR starts_with(path, ${sqlString(`${path}/`)}))`).join(' OR ');
}
function scopeFilter(scope: SemanticScope): string {
	const included = scope.all ? 'true' : pathsFilter(scope.directories) || 'false';
	const excluded = pathsFilter(scope.excluded);
	return `(${included})${excluded ? ` AND NOT (${excluded})` : ''}`;
}

export function vectorQuery(table: Table, request: SemanticSearch): VectorQuery {
	const filter = queryFilter(parseQuery(request.query));
	const conditions = ['empty = 0', scopeFilter(request.scope)];
	if (filter) conditions.push(filter);
	if (request.excludeNoteIds.length) conditions.push(`noteId NOT IN (${request.excludeNoteIds.map(sqlString).join(',')})`);
	// Filtering happens before top-k. Do not use fastSearch: it hides the
	// unindexed tail between maintenance runs, including recently edited notes.
	return table.vectorSearch(request.vector).distanceType('cosine').nprobes(ANN_PROBES)
		.where(conditions.join(' AND '))
		.select(['noteId', 'path', 'version', 'title', 'sourceHash', 'snippet', 'start', 'end', '_distance'])
		.limit(ANN_CHUNK_LIMIT);
}

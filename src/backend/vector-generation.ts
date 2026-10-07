import type { Connection, Table } from '@lancedb/lancedb';
import type { LanceDB } from './global-sdk';
import type { CachedVector, SemanticRequest } from '../embeddings/types';
import type { NoteState, SearchHit } from '../search/types';
import { sqlString } from '../search/query';
import { validateVectors } from '../embeddings/client';
import { VectorAnn } from './vector-ann';
import { vectorQuery, type SemanticSearch } from './vector-query';
import { ANN_CHUNK_LIMIT, ANN_MAX_PARTITIONS } from './vector-config';

interface VectorRow {
	[key: string]: string | number | number[];
	noteId: string; path: string; version: string; title: string; sourceHash: string; tagFilter: string;
	chunkId: string; inputHash: string; start: number; end: number; snippet: string; vector: number[]; empty: number;
}

export class VectorGeneration {
	private table?: Table;
	private ann?: VectorAnn;
	private constructor(private readonly connection: Connection, private readonly sdk: LanceDB, readonly dimensions: number) {}
	static async open(path: string, sdk: LanceDB, dimensions: number): Promise<VectorGeneration> {
		const index = new VectorGeneration(await sdk.connect(path), sdk, dimensions);
		try {
			if ((await index.connection.listTables()).tables.includes('chunks_v1')) {
				index.table = await index.connection.openTable('chunks_v1');
				const fields = new Map((await index.table.schema()).fields.map((field) => [field.name, (field.type as { toString(): string }).toString()]));
				for (const field of ['noteId', 'path', 'version', 'title', 'sourceHash', 'tagFilter', 'chunkId', 'inputHash', 'snippet']) {
					if (fields.get(field) !== 'Utf8') throw new Error('Incompatible semantic cache.');
				}
				for (const field of ['start', 'end', 'empty']) if (fields.get(field) !== 'Float64') throw new Error('Incompatible semantic positions.');
				if (fields.get('vector') !== `FixedSizeList[${dimensions}]<Float32>`) throw new Error('Incompatible vector dimensions.');
				index.ann = await VectorAnn.open(index.table, sdk);
			}
			return index;
		} catch (error) { index.close(); throw error; }
	}
	async states(): Promise<NoteState[]> {
		if (!this.table) return [];
		const rows = await this.table.query().select(['noteId', 'path', 'version']).limit(await this.table.countRows() || 1).toArray() as NoteState[];
		return [...new Map(rows.map((row) => [row.noteId, row])).values()];
	}
	async vectors(noteId: string): Promise<CachedVector[]> {
		if (!this.table) return [];
		const rows = await this.table.query().where(`noteId = ${sqlString(noteId)} AND empty = 0`)
			.select(['inputHash', 'vector']).limit(await this.table.countRows() || 1).toArray() as { inputHash: string; vector: Iterable<number> }[];
		return rows.map((row) => ({ inputHash: row.inputHash, vector: Array.from(row.vector) }));
	}
	async apply(request: Extract<SemanticRequest, { type: 'semantic-apply' }>): Promise<void> {
		const { note, chunks } = request;
		validateVectors({ data: chunks.map((chunk, index) => ({ index, embedding: chunk.vector })) }, chunks.length, this.dimensions);
		const fields = { ...note, tagFilter: `\n${note.tags.join('\n')}\n` };
		// A marker for an empty body records its version without sending text or
		// making it a vector-search candidate. One merge replaces a whole note.
		const data = chunks.length ? chunks : [{ inputHash: '', start: 0, end: 0, snippet: '', vector: Array.from({ length: this.dimensions }, (_, i) => i === 0 ? 1 : 0) }];
		const rows: VectorRow[] = data.map((chunk, index) => ({
			noteId: fields.noteId, path: fields.path, version: fields.version, title: fields.title, sourceHash: fields.sourceHash, tagFilter: fields.tagFilter,
			...chunk, chunkId: `${note.noteId}:${index}`, empty: chunks.length ? 0 : 1,
		}));
		if (!this.table) {
			this.table = await this.connection.createTable('chunks_v1', rows);
			this.ann = await VectorAnn.open(this.table, this.sdk);
		}
		else await this.table.mergeInsert('chunkId').whenMatchedUpdateAll().whenNotMatchedInsertAll()
			.whenNotMatchedBySourceDelete({ where: `noteId = ${sqlString(note.noteId)}` }).execute(rows);
		await this.ann!.changed(rows.length);
	}
	async remove(noteIds: string[]): Promise<void> {
		if (this.table && noteIds.length) {
			await this.table.delete(`noteId IN (${noteIds.map(sqlString).join(',')})`);
			await this.ann!.changed(0, noteIds.length);
		}
	}
	async prepare(): Promise<void> { await this.ann?.prepare(); }
	async search(request: SemanticSearch): Promise<SearchHit[]> {
		validateVectors({ data: [{ index: 0, embedding: request.vector }] }, 1, this.dimensions);
		if (!this.table) return [];
		await this.prepare();
		let rows = await vectorQuery(this.table, request).toArray() as (VectorRow & { _distance: number })[];
		// Expand only when a filter leaves too few candidates. Explicit retries
		// avoid SDK adaptive probing eagerly scanning every partition in parallel.
		if (rows.length < ANN_CHUNK_LIMIT) rows = await vectorQuery(this.table, request).nprobes(ANN_MAX_PARTITIONS).toArray() as typeof rows;
		rows.sort((a, b) => a._distance - b._distance);
		const notes = new Map<string, SearchHit>();
		for (const row of rows) {
			if (!notes.has(row.noteId)) notes.set(row.noteId, {
				noteId: row.noteId, path: row.path, version: row.version, title: row.title, sourceHash: row.sourceHash,
				snippet: row.snippet, start: row.start, end: row.end, score: 1 - row._distance,
			});
		}
		return [...notes.values()];
	}
	close(): void { this.table?.close(); this.connection.close(); }
}

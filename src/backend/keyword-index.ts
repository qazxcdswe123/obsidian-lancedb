import type { Connection, FullTextQuery, Table } from '@lancedb/lancedb';
import type { LanceDB } from './global-sdk';
import type { NoteDocument, NoteState, SearchCandidate, SearchHit, SearchMatches } from '../search/types';
import { parseQuery, phrasePattern, queryFilter, sqlString } from '../search/query';
import { createSnippet, rankNote } from '../search/ranking';

interface NoteRow {
	[key: string]: string | number;
	noteId: string; path: string; version: string; sourceHash: string; title: string;
	aliases: string; tags: string; body: string; bodyStart: number; text: string; identifiers: string; tagFilter: string;
}

const TABLE = 'notes_v1';
export const ICU_OPTIONS = {
	baseTokenizer: 'icu' as const, lowercase: true, stem: false, removeStopWords: false, withPosition: true,
};

export class KeywordIndex {
	private table?: Table;
	private pendingChanges = 0;
	private pendingBytes = 0;
	private maintainedAt = Date.now();
	private constructor(private readonly sdk: LanceDB, private readonly connection: Connection) {}

	static async open(directory: string, sdk: LanceDB): Promise<KeywordIndex> {
		for (const name of ['BooleanQuery', 'MultiMatchQuery', 'PhraseQuery'] as const) {
			if (typeof sdk[name] !== 'function') throw new Error('The installed LanceDB lacks a required keyword query API.');
		}
		const index = new KeywordIndex(sdk, await sdk.connect(directory));
		try {
			if ((await index.connection.listTables()).tables.includes(TABLE)) {
				index.table = await index.connection.openTable(TABLE);
				const fields = new Map((await index.table.schema()).fields.map((field) => [field.name, (field.type as { toString(): string }).toString()]));
				for (const name of ['noteId', 'path', 'version', 'sourceHash', 'title', 'aliases', 'tags', 'body', 'text', 'identifiers', 'tagFilter']) {
					if (fields.get(name) !== 'Utf8') throw new Error('Incompatible keyword table schema.');
				}
				if (fields.get('bodyStart') !== 'Float64') throw new Error('Incompatible source position schema.');
				const indices = await index.table.listIndices();
				for (const column of ['text', 'identifiers']) {
					const config = indices.find((entry) => entry.columns.includes(column));
					if (!config) throw new Error('Incomplete keyword index.');
					const stats = await index.table.indexStats(config.name);
					index.pendingChanges = Math.max(index.pendingChanges, stats?.numUnindexedRows ?? 0);
				}
			}
			return index;
		} catch (error) { index.close(); throw error; }
	}

	async snapshot(): Promise<NoteState[]> {
		if (!this.table) return [];
		return await this.table.query().select(['noteId', 'path', 'version']).limit(await this.table.countRows() || 1).toArray() as NoteState[];
	}

	async apply(notes: NoteDocument[], removed: string[]): Promise<void> {
		if (this.table && removed.length) await this.table.delete(`noteId IN (${removed.map(sqlString).join(',')})`);
		this.pendingChanges += notes.length + removed.length;
		this.pendingBytes += notes.reduce((sum, note) => sum + Buffer.byteLength(note.body), 0);
		if (!notes.length) return;
		const rows: NoteRow[] = notes.map((note) => ({
			...note, aliases: JSON.stringify(note.aliases), tags: JSON.stringify(note.tags),
			text: [note.title, ...note.aliases, ...note.tags, note.body].join('\n'),
			tagFilter: `\n${note.tags.join('\n')}\n`,
		}));
		if (!this.table) {
			this.table = await this.connection.createTable(TABLE, rows);
			for (const column of ['text', 'identifiers']) {
				await this.table.createIndex(column, { config: this.sdk.Index.fts(ICU_OPTIONS) });
			}
		} else {
			await this.table.mergeInsert('noteId').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
		}
	}

	async search(input: string): Promise<SearchMatches> {
		const plan = parseQuery(input);
		if (!input.trim() || !this.table) return { hits: [], total: 0 };
		const count = await this.table.countRows();
		if (!count) return { hits: [], total: 0 };
		const clauses: FullTextQuery[] = [
			...plan.terms.map((term) => new this.sdk.MultiMatchQuery(term, ['text', 'identifiers'], { operator: this.sdk.Operator.And })),
			...plan.phrases.map((phrase) => new this.sdk.PhraseQuery(phrase, 'text')),
		];
		let query = this.table.query();
		if (clauses.length) query = query.fullTextSearch(new this.sdk.BooleanQuery(clauses.map((clause) => [this.sdk.Occur.Must, clause])));
		const filter = queryFilter(plan);
		if (filter) query = query.where(filter);
		// Validate phrases and rank all matching notes before limiting, including filtered queries.
		const columns = ['noteId', 'path', 'version', 'sourceHash', 'title', 'aliases'];
		if (plan.phrases.length) columns.push('tags', 'body');
		if (clauses.length) columns.push('_score');
		const hits: SearchCandidate[] = [];
		for await (const batch of query.select(columns).limit(count)) {
			for (const value of batch.toArray()) {
				const row = value.toJSON() as NoteRow;
				const note = { ...row, aliases: JSON.parse(row.aliases) as string[] };
				if (plan.phrases.length) {
					const fields = [note.title, ...note.aliases, ...JSON.parse(row.tags) as string[], row.body];
					if (!plan.phrases.every((phrase) => fields.some((field) => phrasePattern(phrase).test(field)))) continue;
				}
				const hit = rankNote(note, plan, Number(row._score ?? 0));
				if (hit) hits.push(hit);
			}
		}
		hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		return { hits, total: hits.length };
	}

	async snippets(input: string, candidates: SearchCandidate[]): Promise<SearchHit[]> {
		if (!this.table || !candidates.length) return [];
		const selected = candidates.slice(0, 50);
		const rows = await this.table.query().where(`noteId IN (${selected.map((note) => sqlString(note.noteId)).join(',')})`)
			.select(['noteId', 'version', 'body', 'bodyStart']).limit(selected.length).toArray() as NoteRow[];
		const byId = new Map(rows.map((row) => [row.noteId, row]));
		const plan = parseQuery(input);
		return selected.flatMap((candidate) => {
			const row = byId.get(candidate.noteId);
			return row?.version === candidate.version ? [createSnippet(row, candidate, plan)] : [];
		});
	}

	async maintain(force = false): Promise<void> {
		// Bulk imports should not leave the whole corpus on the unindexed scan path.
		// Single saves remain searchable immediately without rebuilding every index.
		if (!this.table || !this.pendingChanges) return;
		if (!force && this.pendingChanges < 128 && this.pendingBytes < 8 * 1024 * 1024 && Date.now() - this.maintainedAt < 300_000) return;
		await this.table.optimize();
		this.pendingChanges = 0;
		this.pendingBytes = 0;
		this.maintainedAt = Date.now();
	}

	close(): void {
		this.table?.close();
		this.connection.close();
	}
}

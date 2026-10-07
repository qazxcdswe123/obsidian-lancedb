import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSource } from './load-source.mjs';
import { row } from './vector-fixture.mjs';

const { VectorStore } = await loadSource('src/backend/vector-store.ts');
const { vectorQuery } = await loadSource('src/backend/vector-query.ts');
const { SemanticEngine, EmbeddingClient, loadEmbeddingSettings, configurationKey, vectorSpace } = await loadSource('scripts/m3-fixture.mjs');
const { resolveGlobalRuntime } = await loadSource('src/runtime/global-runtime.ts');
const runtime = await resolveGlobalRuntime({ nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' });
const sdk = createRequire(import.meta.url)(join(runtime.globalModulesPath, '@lancedb/lancedb'));
const root = await mkdtemp(join(tmpdir(), 'lancedb-ann-中文 '));
const space = 'a'.repeat(64);
const scope = { all: true, directories: [], excluded: [] };
const search = { type: 'semantic-search', space, vector: [1, 0, 0], query: '', scope, excludeNoteIds: [] };
const lifetime = new AbortController();
let store;

async function inspect(directory, generation, action) {
	const connection = await sdk.connect(join(directory, generation));
	const table = await connection.openTable('chunks_v1');
	try { return await action(table); } finally { table.close(); connection.close(); }
}
function apply(generation, id, vectors, extra = {}) {
	return store.execute({ type: 'semantic-apply', generation,
		note: { noteId: id, path: `Notes/${id}.md`, version: 'v2', title: id, sourceHash: 'hash', tags: ['keep'], ...extra },
		chunks: vectors.map((vector) => ({ vector, inputHash: 'input', start: 0, end: 7, snippet: 'passage' })) });
}

try {
	for (const size of [0, 1, 2, 5]) {
		const directory = join(root, `tiny-${size}`);
		store = await VectorStore.open(directory, sdk);
		const generation = await store.execute({ type: 'semantic-begin', space, dimensions: 3 });
		for (let i = 0; i < size; i++) await apply(generation, `${i}`, [[1, i / 10, 0.1]]);
		await store.execute({ type: 'semantic-commit', generation });
		assert.equal((await store.execute(search)).length, size);
		if (size) await inspect(directory, generation, async (table) => {
			const stats = await table.indexStats('vector_idx');
			assert.equal(stats.indexType, 'IVF_FLAT');
			assert.equal(stats.numUnindexedRows, 0);
			assert.match(await vectorQuery(table, search).explainPlan(false), /ANNSubIndex/);
		});
		if (size === 1) {
			await store.execute({ type: 'semantic-remove', generation, noteIds: ['0'] });
			assert.deepEqual(await store.execute(search), []);
			await apply(generation, 'growth', Array.from({ length: 1024 }, (_, i) => [1, Math.cos(i), Math.sin(i)]));
			await inspect(directory, generation, async (table) => {
				assert.equal(Number((await table.schema()).fields.find((field) => field.name === 'vector').metadata.get('obsidian:ann-partitions')), 32);
				assert.equal((await table.indexStats('vector_idx')).numUnindexedRows, 0);
			});
			assert.equal((await store.execute(search))[0].noteId, 'growth');
		}
		store.close(); store = undefined;
	}
	console.log('PASS: empty and 1/2/5-vector generations, ANN before publication, native ANNSubIndex query plan, empty-to-growing index retraining');

	const directory = join(root, 'legacy');
	const generation = randomUUID();
	const path = "Work/O'Brien";
	const settings = loadEmbeddingSettings({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', secretName: 'key',
		scope: { directories: [path], excluded: [`${path}/Hidden`] }, paused: false });
	settings.approval = { configuration: configurationKey(settings), space: vectorSpace(settings, 3), dimensions: 3, scope: settings.scope };
	const rows = [
		...Array.from({ length: 1200 }, (_, i) => row('long', [1, .01, 0], { path: `${path}/Long.md`, chunkId: `long:${i}` })),
		...Array.from({ length: 70 }, (_, i) => row(`keep-${i}`, [1, .2 + i / 1000, .05], { path: `${path}/${i}.md` })),
		...Array.from({ length: 220 }, (_, i) => row(`hidden-${i}`, [1, 0, 0], { path: `${path}/Hidden/${i}.md` })),
		...Array.from({ length: 220 }, (_, i) => row(`prefix-${i}`, [1, 0, 0], { path: `${path}ish/${i}.md` })),
		...Array.from({ length: 220 }, (_, i) => row(`stale-${i}`, [1, 0, 0], { path: `${path}/Stale/${i}.md` })),
		...Array.from({ length: 220 }, (_, i) => row(`tag-${i}`, [1, 0, 0], { path: `${path}/Tags/${i}.md`, tagFilter: '\nother\n' })),
		row('empty', [1, 0, 0], { path: `${path}/Empty.md`, empty: 1 }),
	];
	await mkdir(directory, { recursive: true });
	const connection = await sdk.connect(join(directory, generation));
	const legacy = await connection.createTable('chunks_v1', rows);
	assert.deepEqual(await legacy.listIndices(), []);
	legacy.close(); connection.close();
	await writeFile(join(directory, 'current.json'), JSON.stringify({ format: 1, generation, space: settings.approval.space, dimensions: 3 }));
	store = await VectorStore.open(directory, sdk);
	const snapshot = await store.execute({ type: 'semantic-snapshot' });
	await inspect(directory, generation, async (table) => assert.deepEqual(await table.listIndices(), []));
	const current = new Map(snapshot.notes.filter((note) => !note.noteId.startsWith('stale-')).map((note) => [note.noteId, note]));
	let sends = 0;
	let batches = 0;
	const engine = new SemanticEngine({
		ready: async () => {}, states: () => [...current.values()], excluded: () => [], read: async () => null,
		isCurrent: (note) => current.get(note.noteId)?.version === note.version && current.get(note.noteId)?.path === note.path,
		request: async (request) => {
			const result = await store.execute(request);
			if (request.type === 'semantic-search') {
				batches++; assert.ok(result.length <= 200);
				assert.ok(result.every((hit) => !/hidden-|prefix-|stale-|tag-|empty/.test(hit.noteId)));
				// Simulate an edit after the database query and before UI delivery.
				if (batches === 2) current.delete(result[0].noteId);
			}
			return result;
		},
	}, new EmbeddingClient(async (request) => {
		sends++; assert.equal(JSON.parse(request.body).input.length, 1);
		return { status: 200, json: { data: [{ index: 0, embedding: [1, 0, 0] }] } };
	}, () => 'fixture'), { settings: () => settings, save: async () => {}, changed: () => {}, signal: lifetime.signal });
	const result = await engine.search(`planet path:"${path}" tag:keep`, lifetime.signal);
	assert.equal(result.total, 50); assert.equal(new Set(result.hits.map((hit) => hit.noteId)).size, 50);
	assert.equal(result.hits[0].noteId, 'long'); assert.equal(sends, 1); assert.equal(batches, 2);
	assert.ok(result.hits.every((hit) => current.has(hit.noteId)));
	await inspect(directory, generation, async (table) => {
		assert.equal(await table.countRows(), rows.length);
		assert.equal((await table.indexStats('vector_idx')).numUnindexedRows, 0);
	});
	const localSearch = { ...search, space: settings.approval.space, scope: settings.scope };
	assert.deepEqual(await store.execute({ ...localSearch, scope: { all: false, directories: [], excluded: [] } }), []);
	console.log('PASS: local legacy migration without reembedding, prefilters with quotes and directory boundaries, stale versions, 1,200-chunk note refill, one query embedding');

	await apply(generation, 'fresh', [[1, 0, .0001]]);
	await apply(generation, 'keep-1', [[0, 1, 0]], { path: `${path}/Renamed.md` });
	await store.execute({ type: 'semantic-remove', generation, noteIds: ['long'] });
	const unfiltered = { ...search, space: settings.approval.space };
	assert.equal((await store.execute({ ...unfiltered, query: 'path:Notes/fresh' }))[0].noteId, 'fresh');
	assert.equal((await store.execute({ ...unfiltered, query: 'path:Renamed' }))[0].version, 'v2');
	assert.deepEqual(await store.execute({ ...unfiltered, query: 'path:Long.md' }), []);
	await inspect(directory, generation, async (table) => assert.ok((await table.indexStats('vector_idx')).numUnindexedRows > 0));
	store.close(); store = await VectorStore.open(directory, sdk);
	assert.equal((await store.execute({ ...unfiltered, query: 'path:Notes/fresh' }))[0].noteId, 'fresh');
	await apply(generation, 'batch', Array.from({ length: 1024 }, () => [0, 0, 1]));
	await inspect(directory, generation, async (table) => assert.equal((await table.indexStats('vector_idx')).numUnindexedRows, 0));
	store.close(); store = undefined;
	// Simulate a stop after writes but before maintenance. Reopen must discover
	// the tail from native index statistics, rather than a reset JS counter.
	await inspect(directory, generation, (table) => table.add(Array.from({ length: 1024 }, (_, i) => row(`tail-${i}`, [0, 1, 1]))));
	store = await VectorStore.open(directory, sdk);
	await store.execute(unfiltered);
	await inspect(directory, generation, async (table) => assert.equal((await table.indexStats('vector_idx')).numUnindexedRows, 0));
	console.log('PASS: unindexed inserts, replacements, deletes, persisted tail visibility, maintenance and recovered native row counts');

	store.close();
	const failingSdk = { ...sdk, Index: { ivfFlat: () => { throw new Error('fixture build failure'); } } };
	store = await VectorStore.open(directory, failingSdk);
	const staging = await store.execute({ type: 'semantic-begin', space, dimensions: 3 });
	await apply(staging, 'new', [[1, 0, 0]]);
	await assert.rejects(store.execute({ type: 'semantic-commit', generation: staging }), /fixture build failure/);
	assert.equal((await store.execute({ type: 'semantic-snapshot' })).generation, generation);
	assert.ok((await store.execute(unfiltered)).length);
	await store.execute({ type: 'semantic-abort', generation: staging });
	console.log('PASS: failed ANN construction cannot publish or replace the active generation');
} finally {
	lifetime.abort(); store?.close(); await rm(root, { recursive: true, force: true });
}

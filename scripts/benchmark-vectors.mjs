import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSource } from './load-source.mjs';
import { row, seededRandom, unit } from './vector-fixture.mjs';

const { VectorGeneration } = await loadSource('src/backend/vector-generation.ts');
const { vectorQuery } = await loadSource('src/backend/vector-query.ts');
const { retrieveSemantic } = await loadSource('src/embeddings/retrieval.ts');
const { resolveGlobalRuntime } = await loadSource('src/runtime/global-runtime.ts');
const runtime = await resolveGlobalRuntime({ nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' });
const sdk = createRequire(import.meta.url)(join(runtime.globalModulesPath, '@lancedb/lancedb'));
const root = await mkdtemp(join(tmpdir(), 'lancedb-vector-scale-'));
const notes = 10000;
const chunks = 3;
const dimensions = 384;
const random = seededRandom(42);
const scope = { all: true, directories: [], excluded: [] };
const queries = [];
let generation;
let connection;
let table;
let maxRss = 0;

function sampleRss() { maxRss = Math.max(maxRss, process.memoryUsage().rss); }
function percentile(samples, fraction) { return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1]; }
async function diskSize(directory) {
	let size = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		size += entry.isDirectory() ? await diskSize(path) : (await stat(path)).size;
	}
	return size;
}

try {
	connection = await sdk.connect(root);
	const start = performance.now();
	for (let offset = 0; offset < notes; offset += 250) {
		const rows = [];
		for (let n = offset; n < Math.min(notes, offset + 250); n++) {
			const base = Array.from({ length: dimensions }, () => random() * 2 - 1);
			for (let c = 0; c < chunks; c++) {
				const vector = unit(base.map((value) => value + (random() * 2 - 1) * .4));
				rows.push(row(`${n}`, vector, { chunkId: `${n}:${c}`, path: `Notes/Group${n % 10}/${n}.md`, tagFilter: `\ngroup${n % 10}\n` }));
			}
			if (queries.length < 40) queries.push(unit(base.map((value) => value * .35 + (random() * 2 - 1))));
		}
		if (!table) table = await connection.createTable('chunks_v1', rows);
		else await table.add(rows);
		sampleRss();
	}
	const writeMs = performance.now() - start;
	generation = await VectorGeneration.open(root, sdk, dimensions);
	const buildStart = performance.now();
	await generation.prepare();
	const buildMs = performance.now() - buildStart;
	table.close(); table = await connection.openTable('chunks_v1');
	const request = { type: 'semantic-search', space: 'a'.repeat(64), vector: queries[0], query: '', scope, excludeNoteIds: [] };
	const plan = await vectorQuery(table, request).explainPlan(false);
	assert.match(plan, /ANNSubIndex/);
	const analysis = await vectorQuery(table, request).analyzePlan();
	const searched = Number(/partitions_searched=(\d+)/.exec(analysis)?.[1]);
	const partitions = Number((await table.schema()).fields.find((field) => field.name === 'vector').metadata.get('obsidian:ann-partitions'));
	assert.ok(searched > 0 && searched < partitions, 'The broad query must probe only part of the ANN index.');
	console.log(analysis.split('\n').filter((line) => /ANNSubIndex|ANNIvfPartition/.test(line)).join('\n'));
	console.log(JSON.stringify({ phase: 'indexed', notes, vectors: notes * chunks, dimensions, writeMs, buildMs, stats: await table.indexStats('vector_idx') }));
	const states = await generation.states();
	const visited = new Set((await vectorQuery(table, request).limit(notes * chunks).toArray()).map((row) => row.noteId));
	const outside = states.find((note) => !visited.has(note.noteId));
	assert.ok(outside, 'The fixture must include a note outside the initial probes.');
	const narrow = { ...request, query: `path:"/${outside.noteId}.md"` };
	assert.equal((await vectorQuery(table, narrow).toArray()).length, 0);
	assert.equal((await generation.search(narrow))[0].noteId, outside.noteId);
	console.log('PASS: narrow filtering expands probes to find a note outside the initial partitions');
	const current = new Map(states.map((note) => [note.noteId, note]));
	const source = { ready: async () => {}, states: () => states, excluded: () => [], read: async () => null,
		isCurrent: (note) => current.get(note.noteId)?.version === note.version,
		request: (query) => generation.search(query) };
	const results = [];
	for (const filter of ['', 'tag:group0']) {
		const annTimes = [], exactTimes = [], recall10 = [], recall50 = [];
		for (let i = 0; i < queries.length + 2; i++) {
			const query = { ...request, vector: queries[i % queries.length], query: filter };
			const annStart = performance.now();
			const result = await retrieveSemantic({ source, indexed: () => states, scope: () => scope, valid: () => true }, query);
			const annMs = performance.now() - annStart;
			const exactStart = performance.now();
			// Materialize every matching chunk to obtain exact top-note ground truth
			// and measure the full retrieval cost before candidate bounding.
			const rows = await vectorQuery(table, query).bypassVectorIndex().limit(notes * chunks).toArray();
			// With a full-table limit the native engine may emit sorted partitions
			// without a global merge. Ground truth needs a global distance ordering.
			rows.sort((a, b) => a._distance - b._distance);
			const seen = new Set();
			const truth = rows.filter((row) => { if (seen.has(row.noteId)) return false; seen.add(row.noteId); return true; }).slice(0, 50);
			const exactMs = performance.now() - exactStart;
			if (i === 0) assert.equal(truth[0].noteId, (await vectorQuery(table, query).bypassVectorIndex().limit(1).toArray())[0].noteId);
			assert.equal(result.hits.length, 50);
			if (i >= 2) {
				annTimes.push(annMs); exactTimes.push(exactMs);
				for (const [k, samples] of [[10, recall10], [50, recall50]]) {
					const ids = new Set(truth.slice(0, k).map((row) => row.noteId));
					samples.push(result.hits.slice(0, k).filter((hit) => ids.has(hit.noteId)).length / k);
				}
			}
			sampleRss();
		}
		const metrics = { filter: filter || 'none', queries: annTimes.length,
			annP50Ms: percentile(annTimes, .5), annP95Ms: percentile(annTimes, .95),
			exactFullP50Ms: percentile(exactTimes, .5), exactFullP95Ms: percentile(exactTimes, .95),
			meanRecall10: recall10.reduce((a, b) => a + b, 0) / recall10.length,
			meanRecall50: recall50.reduce((a, b) => a + b, 0) / recall50.length,
			minimumRecall50: Math.min(...recall50) };
		results.push(metrics); console.log(JSON.stringify(metrics));
	}
	console.log(JSON.stringify({ notes, vectors: notes * chunks, dimensions, writeMs, buildMs, results,
		maxObservedRssMiB: maxRss / 1024 ** 2, diskMiB: (await diskSize(root)) / 1024 ** 2 }));
} finally {
	generation?.close(); table?.close(); connection?.close(); await rm(root, { recursive: true, force: true });
}

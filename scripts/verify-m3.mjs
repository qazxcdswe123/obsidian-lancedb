import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSource } from './load-source.mjs';

const { SearchClient, IndexCoordinator, extractDocument, SemanticEngine, EmbeddingClient, validateVectors,
	loadEmbeddingSettings, configurationKey, vectorSpace, restrictScope, chunkNote, fuseResults, acquireWriterLock,
} = await loadSource('scripts/m3-fixture.mjs');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'lancedb-m3-中文 '));
const cache = join(temporary, 'cache');
const lifetime = new AbortController();
const semanticLifetime = new AbortController();
const settings = loadEmbeddingSettings({ baseUrl: 'https://test.invalid/v1/', model: 'fixture-model', secretName: 'fixture-key', scope: { directories: ['Work'] } });
const excluded = ['Work/Hidden'];
const searchScope = { scope: { all: true, directories: [], excluded: [] }, excludeNoteIds: [] };
const notes = new Map();
const requests = [];
let client;
let coordinator;
let engine;
let saves = 0;
let handler;

const vector = (input) => /星球|planet/i.test(input) ? [1, 0, 0] : /猫|cat/i.test(input) ? [0, 1, 0] : [0, 0, 1];
const response = (input) => ({ status: 200, json: { data: input.map((text, index) => ({ index, embedding: vector(text) })).reverse() } });
const remote = new EmbeddingClient(async (request) => {
	const body = JSON.parse(request.body);
	assert.equal(request.url, 'https://test.invalid/v1/embeddings');
	assert.equal(request.headers.Authorization, 'Bearer fixture-secret');
	assert.equal(body.encoding_format, 'float');
	requests.push(body);
	return handler ? await handler(body) : response(body.input);
}, (name) => name === 'fixture-key' ? 'fixture-secret' : null);

function put(path, body, frontmatter = {}) {
	const header = '---\nprivate: do-not-send-frontmatter\n---\n';
	notes.set(path, { content: header + body, bodyStart: header.length, frontmatter });
	coordinator?.touch(path);
}
async function until(check, label) {
	const end = Date.now() + 15000;
	while (Date.now() < end) { if (await check()) return; await delay(20); }
	throw new Error(`Timed out: ${label}; ${engine?.status}`);
}
async function settled() {
	await coordinator.drain(); engine.refresh();
	await until(() => !engine.timer && !engine.running && !engine.building, 'semantic work settled');
	if (engine.failure) throw new Error(engine.status);
}
function deferred() {
	let resolveValue;
	const promise = new Promise((resolve) => { resolveValue = resolve; });
	return { promise, resolve: resolveValue };
}

try {
	assert.deepEqual(validateVectors({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }, 2), [[1, 0], [0, 1]]);
	for (const data of [[], [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }],
		[{ index: 0, embedding: [NaN] }, { index: 1, embedding: [1] }],
		[{ index: 0, embedding: [0] }, { index: 1, embedding: [1] }],
		[{ index: 0, embedding: [1] }, { index: 1, embedding: [0, 1] }]]) assert.throws(() => validateVectors({ data }, 2));
	assert.throws(() => validateVectors({ data: [{ index: 0, embedding: [1, 0] }] }, 1, 3), /dimensions/);
	assert.equal(vectorSpace(settings, 3), vectorSpace({ ...settings, secretName: 'rotated-key' }, 3));
	assert.notEqual(vectorSpace(settings, 3), vectorSpace({ ...settings, model: 'different-model' }, 3));
	assert.notEqual(configurationKey(settings), configurationKey({ ...settings, chunkChars: 2000 }));
	assert.deepEqual(restrictScope({ all: false, directories: ['Work'], excluded: [] }, { all: false, directories: ['Work/Sub'], excluded: [] }, []), { all: false, directories: ['Work/Sub'], excluded: [] });
	console.log('PASS: response ordering, count, indices, finite nonzero vectors, dimensions and model-space isolation');

	let attempts = 0;
	const held = deferred();
	const limited = new EmbeddingClient(async () => { attempts++; return await held.promise; }, () => 'secret');
	const short = { ...settings, timeoutMs: 20, concurrency: 1 };
	await assert.rejects(limited.embed(short, ['x'], lifetime.signal, () => true), /timed out/);
	await assert.rejects(limited.embed(short, ['x'], lifetime.signal, () => true), /still running/);
	assert.equal(attempts, 1); held.resolve(response(['x'])); await delay(0);
	assert.equal((await limited.embed(short, ['x'], lifetime.signal, () => true))[0].length, 3);
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(limited.embed(short, ['x'], aborted.signal, () => true), /stopped/);
	assert.equal(attempts, 2);
	let retries = 0;
	const flaky = new EmbeddingClient(async () => { retries++; return { status: 429, json: { error: 'private-secret-and-note' } }; }, () => 'secret');
	await assert.rejects(flaky.embed(settings, ['private-note'], lifetime.signal, () => true), (error) => /429/.test(error.message) && !/private/.test(error.message));
	assert.equal(retries, 3);
	console.log('PASS: timeout retains physical concurrency slot, cancellation prevents sends, bounded retries and sanitized errors');

	execFileSync('ditto', ['-x', '-k', resolve(`dist/${manifest.id}-${manifest.version}-darwin-arm64.zip`), temporary]);
	client = new SearchClient({ pluginDirectory: join(temporary, manifest.id), cacheDirectory: cache, version: manifest.version,
		settings: { nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' }, signal: lifetime.signal, onFailure: () => {} });
	put('Work/Planets.md', '# Space\n\n星球 orbit\n\nStable passage.', { tags: ['space'], aliases: ['private-alias'] });
	put('Work/Cats.md', '# Animals\n\n猫 cat');
	put('Personal/Private.md', 'outside-scope-private');
	put('Work/Hidden/Secret.md', 'local-exclusion-private');
	put('Work/Empty.md', '');
	coordinator = new IndexCoordinator(client, { paths: () => [...notes.keys()], excludedDirectories: () => excluded, read: async (path) => notes.get(path) ?? null }, () => engine?.refresh());
	await coordinator.start(); await coordinator.drain();
	const source = {
		ready: () => coordinator.drain(), states: () => coordinator.states(), isCurrent: (note) => coordinator.isCurrent(note), excluded: () => excluded,
		request: (request) => client.request(request),
		read: async (note) => notes.has(note.path) ? extractDocument({ ...notes.get(note.path), noteId: note.noteId, path: note.path }) : null,
	};
	engine = new SemanticEngine(source, remote, { settings: () => settings, save: async () => { saves++; }, signal: semanticLifetime.signal, changed: () => {} });
	engine.refresh(); await delay(400); assert.equal(requests.length, 0);
	engine.settingsChanged(); await delay(400); assert.equal(requests.length, 0);
	assert.equal(await engine.testConnection(), 3);
	assert.equal(requests.length, 1); assert.equal(requests[0].input.length, 2); assert.equal(requests[0].dimensions, undefined);
	await delay(400); assert.equal(requests.length, 1);
	await engine.build(); await settled();
	assert.equal(settings.approval.dimensions, 3); assert.ok(saves > 0);
	assert.ok(!JSON.stringify(requests).match(/do-not-send-frontmatter|private-alias|Planets\.md|outside-scope-private|local-exclusion-private/));
	assert.equal((await client.request({ type: 'semantic-snapshot' })).notes.length, 3);
	const semantic = await engine.search('星球 path:Work tag:space', lifetime.signal);
	assert.equal(semantic.hits[0].path, 'Work/Planets.md');
	assert.equal(semantic.total, 1);
	const hit = semantic.hits[0];
	assert.match(notes.get(hit.path).content.slice(hit.start, hit.end), /星球/);
	assert.deepEqual(requests.at(-1).input, ['星球']);
	const fused = fuseResults(await coordinator.search('星球'), semantic);
	assert.equal(fused.hits.length, 1); assert.equal(fused.hits[0].noteId, hit.noteId);
	console.log('PASS: default-off and save/test boundaries, explicit build, selected scope only, native cosine search, local filters, source offsets and rank fusion');

	let before = requests.length;
	put('Work/Planets.md', '# Space\n\n星球 orbit updated\n\nStable passage.', { tags: ['space'] });
	await settled();
	const sent = requests.slice(before).flatMap((request) => request.input);
	assert.equal(sent.length, 1); assert.match(sent[0], /updated/); assert.ok(!sent[0].includes('Stable passage'));
	before = requests.length;
	put('Work/Planets.md', '# Space\n\n星球 orbit updated\n\nStable passage.', { tags: ['new-tag'] });
	await settled(); assert.equal(requests.length, before);
	notes.set('Work/Renamed.md', notes.get('Work/Planets.md')); notes.delete('Work/Planets.md'); coordinator.rename('Work/Planets.md', 'Work/Renamed.md');
	await settled(); assert.equal(requests.length, before);
	assert.equal((await engine.search('星球 tag:new-tag', lifetime.signal)).hits[0].path, 'Work/Renamed.md');

	const waitResponse = deferred(); const entered = deferred();
	handler = async (body) => { entered.resolve(); await waitResponse.promise; return response(body.input); };
	put('Work/Cats.md', '# Animals\n\n猫 modified while in flight'); engine.refresh(); await entered.promise;
	notes.delete('Work/Cats.md'); coordinator.remove('Work/Cats.md');
	waitResponse.resolve(); handler = undefined; await settled();
	assert.ok(!(await client.request({ type: 'semantic-snapshot' })).notes.some((note) => note.path === 'Work/Cats.md'));
	console.log('PASS: unchanged passages reused, metadata-only edits and renames need no embeddings, deletion rejects an in-flight response');

	settings.scope = { all: false, directories: ['Work/Renamed.md'], excluded: [] }; engine.settingsChanged();
	await engine.resume(); await settled();
	assert.equal((await client.request({ type: 'semantic-snapshot' })).notes.length, 1);
	before = requests.length;
	settings.scope = { all: true, directories: [], excluded: [] }; engine.settingsChanged(); await engine.resume(); await settled();
	assert.equal(requests.length, before); assert.equal((await client.request({ type: 'semantic-snapshot' })).notes.length, 1);
	settings.model = 'different-model'; engine.settingsChanged();
	await assert.rejects(engine.resume(), /Test the connection/);
	await assert.rejects(engine.search('星球', lifetime.signal), /settings changed/);
	assert.equal(requests.length, before);
	settings.model = 'fixture-model'; engine.settingsChanged(); await engine.resume(); await settled();
	console.log('PASS: scope shrink removes rows, expanding scope cannot send unapproved notes, same-dimension model changes require a new build');

	const activeBeforePause = await client.request({ type: 'semantic-snapshot' });
	const pendingBuild = deferred(); const buildEntered = deferred();
	handler = async (body) => { buildEntered.resolve(); await pendingBuild.promise; return response(body.input); };
	const rebuild = engine.build();
	const cancelledBuild = assert.rejects(rebuild, /stopped/);
	await buildEntered.promise; await engine.pause();
	pendingBuild.resolve(); handler = undefined; await cancelledBuild;
	assert.equal((await client.request({ type: 'semantic-snapshot' })).generation, activeBeforePause.generation);
	await engine.resume(); await settled();
	handler = async () => ({ status: 401, json: { error: 'private-provider-error' } });
	await assert.rejects(engine.search('星球', lifetime.signal), (error) => /HTTP 401/.test(error.message) && !error.message.includes('private'));
	assert.equal(settings.paused, true);
	assert.ok((await coordinator.search('星球')).total > 0);
	handler = undefined; await engine.resume(); await settled();
	handler = async () => ({ status: 200, json: { data: [{ index: 0, embedding: [1, 0] }] } });
	await assert.rejects(engine.search('星球', lifetime.signal), /dimensions/);
	assert.equal(settings.paused, true);
	handler = undefined; await engine.resume(); await settled();
	console.log('PASS: pausing a rebuild discards late work and preserves active generation; authentication/dimension failures pause remote calls while keywords work');

	const snapshot = await client.request({ type: 'semantic-snapshot' });
	const staging = await client.request({ type: 'semantic-begin', space: snapshot.space, dimensions: snapshot.dimensions });
	assert.equal((await client.request({ type: 'semantic-search', space: snapshot.space, vector: [1, 0, 0], query: '', ...searchScope })).length, 1);
	await client.request({ type: 'semantic-abort', generation: staging });
	await assert.rejects(client.request({ type: 'semantic-remove', generation: staging, noteIds: [hit.noteId] }));
	await assert.rejects(client.request({ type: 'semantic-search', space: 'a'.repeat(64), vector: [1, 0, 0], query: '', ...searchScope }));
	semanticLifetime.abort(); coordinator.stop();
	await until(async () => { try { const release = await acquireWriterLock(cache); await release(); return true; } catch { return false; } }, 'lock release');
	const restarted = new SearchClient({ pluginDirectory: join(temporary, manifest.id), cacheDirectory: cache, version: manifest.version,
		settings: { nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' }, signal: lifetime.signal, onFailure: () => {} });
	client = restarted;
	assert.equal((await restarted.request({ type: 'semantic-snapshot' })).generation, snapshot.generation);
	assert.equal((await restarted.request({ type: 'semantic-search', space: snapshot.space, vector: [1, 0, 0], query: '', ...searchScope })).length, 1);
	console.log('PASS: staging preserves active search, obsolete generations and mismatched spaces rejected, persisted vector cache reopens');

	const missingLifetime = new AbortController();
	const restored = structuredClone(settings); restored.paused = false;
	const beforeMissing = requests.length;
	const missing = new SemanticEngine({ ...source, ready: async () => {}, request: async () => ({ generation: '', space: '', dimensions: 0, notes: [], needsRebuild: false }) }, remote,
		{ settings: () => restored, save: async () => {}, signal: missingLifetime.signal, changed: () => {} });
	missing.refresh(); await until(() => restored.paused, 'missing cache stops remote work');
	assert.match(missing.status, /Build it manually/); assert.equal(requests.length, beforeMissing); missingLifetime.abort();
	console.log('PASS: a missing semantic cache never triggers an automatic paid rebuild');

	const unicode = extractDocument({ noteId: 'unicode', path: 'private-filename.md', content: '---\nsecret\n---\n# 标题\n\n' + '🪐'.repeat(350), bodyStart: 15, frontmatter: {} });
	for (const chunk of chunkNote(unicode, 201)) {
		assert.ok(!/^[\uDC00-\uDFFF]/.test(unicode.body.slice(chunk.start - unicode.bodyStart)));
		assert.ok(!/[\uD800-\uDBFF]$/.test(unicode.body.slice(chunk.start - unicode.bodyStart, chunk.end - unicode.bodyStart)));
		assert.ok(!chunk.input.includes('private-filename'));
	}
	await writeFile(join(temporary, 'evidence.json'), JSON.stringify({ requests: requests.length, saves }));
	console.log('PASS: Unicode chunk boundaries; all remote traffic used synthetic fixtures and a controlled transport');
} finally {
	semanticLifetime.abort(); lifetime.abort(); coordinator?.stop(); client?.close(); await delay(300);
	await rm(temporary, { recursive: true, force: true });
}

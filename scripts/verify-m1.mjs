import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSource } from './load-source.mjs';

const { acquireWriterLock } = await loadSource('src/backend/writer-lock.ts');
const { SearchClient } = await loadSource('src/runtime/search-client.ts');
const { IndexCoordinator } = await loadSource('src/indexing/coordinator.ts');
const { extractDocument } = await loadSource('src/indexing/document.ts');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'lancedb-m1-中文 '));
const clients = [];
const lifetime = new AbortController();
const failures = [];
let coordinator;

function createClient(cacheDirectory) {
	const client = new SearchClient({
		pluginDirectory: join(temporary, manifest.id), cacheDirectory, version: manifest.version,
		settings: { nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' },
		signal: lifetime.signal, onFailure: (message) => failures.push(message),
	});
	clients.push(client);
	return client;
}

function document(path, body, frontmatter = {}) {
	return extractDocument({ noteId: path, path, content: body, bodyStart: 0, frontmatter });
}

async function lockReleased(cache) {
	try { const release = await acquireWriterLock(cache); await release(); return true; }
	catch (error) { if (error.message.includes('occupied')) return false; throw error; }
}

async function until(check, label, timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(25);
	}
	throw new Error(`Timed out: ${label}`);
}

try {
	execFileSync('ditto', ['-x', '-k', resolve(`dist/${manifest.id}-${manifest.version}-darwin-arm64.zip`), temporary]);
	const cache = join(temporary, 'cache');
	const client = createClient(cache);
	const started = performance.now();
	const initial = await client.snapshot();
	assert.deepEqual(initial.notes, []);
	const generation = initial.generation;
	const coldStartMs = performance.now() - started;
	const documents = [
		document('本地笔记.md', 'Local SEARCH running the\n\n跨段落 火星 getUserName foo-bar', { aliases: ['Knowledge base'], tags: ['research/中文'] }),
		document('alpha.md', 'beta marker'),
		document('phrase.md', 'alpha beta marker'),
		document('multiline.md', 'introduction\n\nalpha\nbeta'),
		document('aliases.md', 'marker', { aliases: ['alpha', 'beta'] }),
		document('folder/quote\'s.md', 'durable database', { tags: ['book'] }),
		document('frontmatter.md', 'visible #inline `#code`\n```js\n#fenced\n```', { tags: ['front'] }),
		...Array.from({ length: 250 }, (_, i) => document(`distractor/${i}.md`, 'needle content')),
		document('target/last.md', 'needle content', { tags: ['selected'] }),
		document('needle.md', 'irrelevant body'),
	];
	await client.request({ type: 'apply', generation, notes: documents, removed: [] });
	const paths = async (query) => (await client.search(query)).hits.map((hit) => hit.path);
	assert.deepEqual(await paths('笔记 火星'), ['本地笔记.md']);
	assert.deepEqual(await paths('knowledge 火星'), ['本地笔记.md']);
	assert.deepEqual(await paths('local search'), ['本地笔记.md']);
	assert.deepEqual(await paths('run'), []);
	assert.deepEqual(await paths('the'), ['本地笔记.md']);
	assert.deepEqual(await paths('user name'), ['本地笔记.md']);
	assert.deepEqual(await paths('"user name"'), []);
	assert.deepEqual((await paths('"alpha beta"')).sort(), ['multiline.md', 'phrase.md']);
	const multiline = (await client.search('"alpha beta"')).hits.find((hit) => hit.path === 'multiline.md');
	assert.equal('introduction\n\nalpha\nbeta'.slice(multiline.start, multiline.end), 'alpha\nbeta');
	assert.equal((await paths('knowledge base'))[0], '本地笔记.md');
	assert.equal((await paths('needle'))[0], 'needle.md');
	assert.deepEqual(await paths('needle path:target tag:selected'), ['target/last.md']);
	assert.deepEqual(await paths('path:"folder/quote\'s"'), ["folder/quote's.md"]);
	assert.deepEqual(await paths('tag:research/中文'), ['本地笔记.md']);
	assert.deepEqual(await paths('tag:inline tag:front'), ['frontmatter.md']);
	assert.deepEqual(await paths('tag:code'), []);
	assert.deepEqual(await paths('tag:fenced'), []);
	const hit = (await client.search('火星')).hits[0];
	assert.equal(documents[0].body.slice(hit.start, hit.end), '火星');
	console.log('PASS: Chinese, cross-field/paragraph AND, phrases, identifiers, exact ranking, filters beyond 250 candidates, source offsets');

	await client.request({ type: 'apply', generation, notes: [document('本地笔记.md', '新增中文 木星')], removed: [] });
	assert.deepEqual(await paths('木星'), ['本地笔记.md']);
	assert.deepEqual(await paths('火星'), []);
	await client.request({ type: 'apply', generation, notes: [], removed: ['本地笔记.md'] });
	assert.deepEqual(await paths('木星'), []);
	const durations = [];
	for (let i = 0; i < 40; i++) {
		const before = performance.now();
		await client.search(i % 2 ? 'needle path:target' : 'needle');
		durations.push(performance.now() - before);
	}
	durations.sort((a, b) => a - b);
	console.log(JSON.stringify({ notes: documents.length, coldProcessStartMs: Math.round(coldStartMs), queryIpcP95Ms: Math.round(durations[37]) }));
	const occupied = createClient(cache);
	await assert.rejects(occupied.snapshot(), /occupied/);
	occupied.close();
	client.close();
	await until(async () => lockReleased(cache), 'writer exit');
	const reopened = createClient(cache);
	assert.equal((await reopened.search('needle')).hits[0].path, 'needle.md');
	console.log('PASS: update/delete, concurrent writer rejected, graceful release, persisted reopen');
	const emptyGeneration = await reopened.request({ type: 'begin-rebuild' });
	await reopened.request({ type: 'commit-rebuild', generation: emptyGeneration });

	const source = new Map([
		['one.md', 'original note'], ['other.md', 'local 文本'], ['excluded/secret.md', 'private note'],
	]);
	let excluded = ['excluded'];
	let delayedRead;
	let releaseRead;
	let heldPath;
	let delayWrite;
	let releaseWrite;
	let writeEntered;
	const port = {
		snapshot: () => reopened.snapshot(), search: (query, accept) => reopened.search(query, accept), close: () => reopened.close(),
		request: async (request) => {
			const result = await reopened.request(request);
			if (request.type === 'apply' && delayWrite) { writeEntered(); await delayWrite; delayWrite = undefined; }
			return result;
		},
	};
	coordinator = new IndexCoordinator(port, {
		paths: () => [...source.keys()], excludedDirectories: () => excluded,
		read: async (path) => {
			const content = source.get(path);
			if (path === heldPath) { delayedRead(); await new Promise((resolveRead) => { releaseRead = resolveRead; }); heldPath = undefined; }
			return content === undefined ? null : { content, bodyStart: 0, frontmatter: {} };
		},
	}, () => {});
	await coordinator.start();
	await until(() => coordinator.status === '2 notes indexed locally', 'initial indexing');
	assert.equal((await coordinator.search('private')).total, 0);
	const beforeRename = (await coordinator.search('original')).hits[0];
	source.set('renamed.md', source.get('one.md')); source.delete('one.md');
	coordinator.rename('one.md', 'renamed.md');
	await until(async () => (await coordinator.search('original')).hits[0]?.path === 'renamed.md', 'rename');
	assert.equal((await coordinator.search('original')).hits[0].noteId, beforeRename.noteId);
	source.set('folder/moved.md', source.get('renamed.md')); source.delete('renamed.md');
	coordinator.rename('renamed.md', 'folder/moved.md');
	await until(async () => (await coordinator.search('original')).hits[0]?.path === 'folder/moved.md', 'move into folder');
	source.set('renamed-folder/moved.md', source.get('folder/moved.md')); source.delete('folder/moved.md');
	coordinator.renameDirectory('folder', 'renamed-folder');
	await until(async () => (await coordinator.search('original')).hits[0]?.path === 'renamed-folder/moved.md', 'folder rename');
	assert.equal((await coordinator.search('original')).hits[0].noteId, beforeRename.noteId);
	source.set('renamed.md', source.get('renamed-folder/moved.md')); source.delete('renamed-folder/moved.md');
	coordinator.rename('renamed-folder/moved.md', 'renamed.md');
	await until(async () => (await coordinator.search('original')).hits[0]?.path === 'renamed.md', 'move out of folder');

	heldPath = 'renamed.md';
	const reading = new Promise((resolveRead) => { delayedRead = resolveRead; });
	source.set('renamed.md', 'delayed stale content'); coordinator.touch('renamed.md');
	await reading;
	source.delete('renamed.md'); coordinator.remove('renamed.md'); releaseRead();
	await until(() => coordinator.status === '1 notes indexed locally', 'delete during read');
	assert.equal((await coordinator.search('stale')).total, 0);
	assert.equal((await coordinator.search('original')).total, 0);

	const entered = new Promise((resolveWrite) => { writeEntered = resolveWrite; });
	delayWrite = new Promise((resolveWrite) => { releaseWrite = resolveWrite; });
	source.set('other.md', 'temporary intermediate'); coordinator.touch('other.md');
	await entered;
	source.set('other.md', 'local 文本'); coordinator.touch('other.md'); releaseWrite();
	await until(async () => (await coordinator.search('文本')).total === 1, 'edit then revert during write');
	assert.equal((await coordinator.search('intermediate')).total, 0);
	excluded = []; coordinator.reconcile();
	await until(async () => (await coordinator.search('private')).total === 1, 'scope expansion');
	excluded = ['excluded']; coordinator.reconcile();
	assert.equal((await coordinator.search('private')).total, 0);
	await coordinator.rebuild();
	await until(() => coordinator.status === '1 notes indexed locally', 'rebuild');
	assert.equal((await coordinator.search('文本')).total, 1);
	console.log('PASS: coordinator rename identity, excluded scope, delete during read, edit/revert during write, rebuild');
	coordinator.stop();
	await until(async () => lockReleased(cache), 'shutdown cleanup');
	assert.equal(failures.filter((message) => !message.startsWith('This index is occupied.')).length, 0);
} finally {
	coordinator?.stop();
	for (const client of clients) client.close();
	lifetime.abort();
	await delay(2200);
	await rm(temporary, { recursive: true, force: true });
}

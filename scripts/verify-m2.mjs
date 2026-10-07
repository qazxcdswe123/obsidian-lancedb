import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSource } from './load-source.mjs';

const { SearchClient } = await loadSource('src/runtime/search-client.ts');
const { IndexCoordinator } = await loadSource('src/indexing/coordinator.ts');
const { extractDocument } = await loadSource('src/indexing/document.ts');
const { deviceId } = await loadSource('src/runtime/device-id.ts');
const { acquireWriterLock } = await loadSource('src/backend/writer-lock.ts');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'lancedb-m2-中文 '));
const cache = join(temporary, 'vault', '.test-config', 'plugins', manifest.id, 'cache', 'device');
const lifetime = new AbortController();
const clients = [];
const failures = [];
let coordinator;

function client() {
	const value = new SearchClient({
		pluginDirectory: join(temporary, manifest.id), cacheDirectory: cache, version: manifest.version,
		settings: { nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' },
		signal: lifetime.signal, onFailure: (message, recoverable) => failures.push({ message, recoverable }),
	});
	clients.push(value);
	return value;
}

function note(content, id = 'note') {
	return extractDocument({ noteId: id, path: `${id}.md`, content, frontmatter: {}, bodyStart: 0 });
}

async function until(check, label) {
	const end = Date.now() + 15000;
	while (Date.now() < end) { if (await check()) return; await delay(20); }
	throw new Error(`Timed out: ${label}`);
}

async function released() {
	await until(async () => {
		try { const release = await acquireWriterLock(cache); await release(); return true; }
		catch (error) { if (error.message.includes('occupied')) return false; throw error; }
	}, 'kernel lock release');
}

try {
	execFileSync('ditto', ['-x', '-k', resolve(`dist/${manifest.id}-${manifest.version}-darwin-arm64.zip`), temporary]);
	const a = client();
	const generation = (await a.snapshot()).generation;
	await a.request({ type: 'apply', generation, notes: [note('original document')], removed: [] });
	const second = client();
	await assert.rejects(second.snapshot(), /occupied/); second.close();
	const staging = await a.request({ type: 'begin-rebuild' });
	await a.request({ type: 'apply', generation: staging, notes: [note('replacement document')], removed: [] });
	assert.equal((await a.search('original')).total, 1);
	assert.equal((await a.search('replacement')).total, 0);
	await a.request({ type: 'commit-rebuild', generation: staging });
	assert.equal((await a.search('replacement')).total, 1);
	await assert.rejects(a.request({ type: 'apply', generation, notes: [note('stale write')], removed: [] }));
	assert.equal((await a.search('stale')).total, 0);
	const abandoned = await a.request({ type: 'begin-rebuild' });
	await a.request({ type: 'apply', generation: abandoned, notes: [note('uncommitted rebuild')], removed: [] });
	a.child.kill('SIGKILL');
	await released(); a.close();
	assert.ok(failures.some((failure) => failure.recoverable));
	const b = client();
	assert.equal((await b.snapshot()).generation, staging);
	assert.equal((await b.search('replacement')).total, 1);
	assert.equal((await b.search('uncommitted')).total, 0);
	assert.deepEqual(await readdir(join(cache, 'generations')), [staging]);
	console.log('PASS: kernel exclusion, SIGKILL releases ownership, atomic generation switch, stale writes rejected, interrupted rebuild discarded');

	// Rebuilds must retain active results while reading, and forward edits arriving during commit.
	const source = new Map([['note.md', 'replacement document']]);
	let heldRead;
	let readEntered;
	let unblockRead;
	let holdCommit;
	let commitEntered;
	let unblockCommit;
	const port = {
		snapshot: () => b.snapshot(), search: (query, accept) => b.search(query, accept), close: () => b.close(),
		request: async (request) => {
			const result = await b.request(request);
			if (request.type === 'commit-rebuild' && holdCommit) { commitEntered(); await holdCommit; holdCommit = undefined; }
			return result;
		},
	};
	coordinator = new IndexCoordinator(port, {
		paths: () => [...source.keys()], excludedDirectories: () => [],
		read: async (path) => {
			const content = source.get(path);
			if (heldRead) { readEntered(); await heldRead; heldRead = undefined; }
			return content === undefined ? null : { content, bodyStart: 0, frontmatter: {} };
		},
	}, () => {});
	await coordinator.start();
	await until(() => coordinator.status === '1 notes indexed locally', 'coordinator startup');
	const reading = new Promise((resolveRead) => { readEntered = resolveRead; });
	heldRead = new Promise((resolveRead) => { unblockRead = resolveRead; });
	const rebuilding = coordinator.rebuild();
	await reading;
	assert.equal((await coordinator.search('replacement')).total, 1);
	const committing = new Promise((resolveCommit) => { commitEntered = resolveCommit; });
	holdCommit = new Promise((resolveCommit) => { unblockCommit = resolveCommit; });
	unblockRead(); await committing;
	source.set('note.md', 'newest content'); coordinator.touch('note.md');
	unblockCommit(); await rebuilding;
	await until(async () => (await coordinator.search('newest')).total === 1, 'edit during generation switch');
	assert.equal((await coordinator.search('replacement')).total, 0);
	coordinator.stop(); coordinator = undefined; await released();
	console.log('PASS: old index remains searchable during rebuild; edits during commit reach the new generation');

	const before = await readFile(join(cache, 'current.json'), 'utf8');
	await writeFile(join(cache, 'current.json'), JSON.stringify({ format: 999, generation: '../outside' }));
	const c = client();
	assert.equal((await c.snapshot()).needsRebuild, true);
	await assert.rejects(c.search('newest'));
	const fresh = await c.request({ type: 'begin-rebuild' });
	await c.request({ type: 'apply', generation: fresh, notes: [note('compatible again')], removed: [] });
	await c.request({ type: 'commit-rebuild', generation: fresh });
	assert.equal((await c.snapshot()).needsRebuild, false);
	assert.equal((await c.search('compatible')).total, 1);
	assert.notEqual(await readFile(join(cache, 'current.json'), 'utf8'), before);
	// Source offsets survive a large IPC payload and UTF-16 characters.
	const large = note('🪐 '.repeat(400000) + '\nlongnoteend', 'long');
	await c.request({ type: 'apply', generation: fresh, notes: [large], removed: [] });
	const largeHit = (await c.search('longnoteend')).hits[0];
	assert.equal(large.body.slice(largeHit.start, largeHit.end), 'longnoteend');
	console.log('PASS: unsupported cache format requests rebuild, explicit recovery, large Unicode note and source offset');

	const batchSource = new Map([['a.md', 'alpha moved'], ['b.md', 'beta stayed'], ['c.md', 'gamma removed']]);
	let releaseBatch;
	let enterBatch;
	const enteredBatch = new Promise((resolveBatch) => { enterBatch = resolveBatch; });
	let holdBatch = true;
	coordinator = new IndexCoordinator(c, {
		paths: () => [...batchSource.keys()], excludedDirectories: () => [],
		read: async (path) => {
			if (path === 'b.md' && holdBatch) {
				holdBatch = false; enterBatch();
				await new Promise((resolveBatch) => { releaseBatch = resolveBatch; });
			}
			const content = batchSource.get(path);
			return content === undefined ? null : { content, bodyStart: 0, frontmatter: {} };
		},
	}, () => {});
	await coordinator.start(); await enteredBatch;
	batchSource.delete('c.md'); coordinator.remove('c.md');
	batchSource.set('c.md', batchSource.get('a.md')); batchSource.delete('a.md'); coordinator.rename('a.md', 'c.md');
	releaseBatch();
	await until(() => coordinator.status === '2 notes indexed locally', 'rename across a pending batch');
	assert.equal((await coordinator.search('alpha')).hits[0].path, 'c.md');
	assert.equal((await coordinator.search('gamma')).total, 0);
	coordinator.stop(); coordinator = undefined; await released();
	console.log('PASS: rename into a deleted path within a pending batch does not submit duplicate or stale rows');

	const local = new Map();
	const storage = { loadLocalStorage: (key) => local.get(key), saveLocalStorage: (key, value) => local.set(key, value) };
	assert.equal(deviceId(storage), deviceId(storage));
	const another = new Map();
	assert.notEqual(deviceId(storage), deviceId({ loadLocalStorage: (key) => another.get(key), saveLocalStorage: (key, value) => another.set(key, value) }));
	const vault = join(temporary, 'vault');
	await writeFile(join(vault, '.gitignore'), '.test-config/plugins/lancedb-search/cache/\n');
	await writeFile(join(vault, 'note.md'), 'sync this note');
	execFileSync('git', ['init', '-q', vault]);
	execFileSync('git', ['-C', vault, 'check-ignore', '.test-config/plugins/lancedb-search/cache/device/writer.lock']);
	const synced = join(temporary, 'synced'); await mkdir(synced);
	execFileSync('rsync', ['-a', '--exclude=.git/', '--exclude=.test-config/plugins/lancedb-search/cache/', `${vault}/`, `${synced}/`]);
	assert.equal(await readFile(join(synced, 'note.md'), 'utf8'), 'sync this note');
	await assert.rejects(readFile(join(synced, '.test-config/plugins/lancedb-search/cache/device/current.json')));
	console.log('PASS: local device IDs, Git ignore and explicit rsync cache exclusion (not an Obsidian Sync test)');
} finally {
	coordinator?.stop();
	for (const value of clients) value.close();
	lifetime.abort();
	await delay(2200);
	await rm(temporary, { recursive: true, force: true });
}

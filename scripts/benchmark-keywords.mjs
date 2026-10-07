import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSource } from './load-source.mjs';

const { KeywordIndex } = await loadSource('src/backend/keyword-index.ts');
const { extractDocument } = await loadSource('src/indexing/document.ts');
const { resolveGlobalRuntime } = await loadSource('src/runtime/global-runtime.ts');
const runtime = await resolveGlobalRuntime({ nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' });
const sdk = createRequire(import.meta.url)(join(runtime.globalModulesPath, '@lancedb/lancedb'));
const root = await mkdtemp(join(tmpdir(), 'lancedb-m1-scale-'));
let index;
let bytes = 0;
let maxRss = 0;
const count = 10000;

async function diskSize(directory) {
	let size = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		size += entry.isDirectory() ? await diskSize(path) : (await stat(path)).size;
	}
	return size;
}

async function queryP95(query) {
	const samples = [];
	for (let i = 0; i < 22; i++) {
		const before = performance.now();
		const result = await index.search(query);
		await index.snippets(query, result.hits.slice(0, 50));
		const duration = performance.now() - before;
		if (!result.total) throw new Error('Missing scale result.');
		if (i >= 2) samples.push(duration);
		maxRss = Math.max(maxRss, process.memoryUsage().rss);
	}
	return samples.sort((a, b) => a - b)[18];
}

try {
	index = await KeywordIndex.open(root, sdk);
	const start = performance.now();
	for (let offset = 0; offset < count; offset += 32) {
		const rows = Array.from({ length: Math.min(32, count - offset) }, (_, i) => {
			const n = offset + i;
			const prefix = `本地笔记 search performance document${n}\n\n`;
			const content = prefix + 'Local database stores text for keyword retrieval. '.repeat(Math.ceil((10486 - Buffer.byteLength(prefix)) / 49));
			bytes += Buffer.byteLength(content);
			return extractDocument({
				noteId: String(n), path: `notes/Document ${n}.md`, content, bodyStart: 0,
				frontmatter: { tags: [`group${n % 100}`] },
			});
		});
		await index.apply(rows, []);
		maxRss = Math.max(maxRss, process.memoryUsage().rss);
		if (offset % 1024 === 0) console.log(JSON.stringify({ indexed: offset + rows.length, elapsedMs: Math.round(performance.now() - start) }));
	}
	await index.maintain();
	const indexedMs = Math.round(performance.now() - start);
	const selectiveP95Ms = await queryP95('document9950');
	const filtered100P95Ms = await queryP95('search tag:group50');
	const broadAllP95Ms = await queryP95('search');
	const all = await index.search('search');
	console.log(JSON.stringify({
		notes: count, sourceMiB: bytes / 1024 ** 2, indexedMs, selectiveP95Ms, filtered100P95Ms,
		broadAllP95Ms, total: all.total,
		maxObservedRssMiB: Math.max(maxRss, process.memoryUsage().rss) / 1024 ** 2,
		diskMiB: (await diskSize(root)) / 1024 ** 2,
	}));
} finally {
	index?.close();
	await rm(root, { recursive: true, force: true });
}

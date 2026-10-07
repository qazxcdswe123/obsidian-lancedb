import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexSnapshot, SearchRequest, SearchReply } from '../search/types';
import type { LanceDB } from './global-sdk';
import { KeywordIndex } from './keyword-index';
import { VectorStore } from './vector-store';

interface Generation { id: string; index: KeywordIndex }
const FORMAT = 2;
const GENERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class IndexStore {
	private active?: Generation;
	private staging?: Generation;
	private needsRebuild = false;
	private vectors?: VectorStore;
	private constructor(private readonly root: string, private readonly sdk: LanceDB) {}

	static async open(root: string, sdk: LanceDB): Promise<IndexStore> {
		const store = new IndexStore(root, sdk);
		await mkdir(join(root, 'generations'), { recursive: true });
		let saved: unknown;
		try { saved = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { store.needsRebuild = true; return store; }
			try { await stat(join(root, 'database')); store.needsRebuild = true; return store; }
			catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError; }
			store.active = await store.createGeneration();
			await store.publish(store.active.id);
			return store;
		}
		const header = saved as { format?: number; generation?: string } | null;
		if (header?.format !== FORMAT || !header.generation || !GENERATION.test(header.generation)) {
			store.needsRebuild = true;
			return store;
		}
		try {
			const directory = join(root, 'generations', header.generation);
			await stat(directory);
			store.active = { id: header.generation, index: await KeywordIndex.open(directory, sdk) };
		} catch { store.needsRebuild = true; return store; }
		await store.removeAbandoned();
		return store;
	}

	private async createGeneration(): Promise<Generation> {
		const id = randomUUID();
		const directory = join(this.root, 'generations', id);
		await mkdir(directory);
		return { id, index: await KeywordIndex.open(directory, this.sdk) };
	}

	private async publish(id: string): Promise<void> {
		const temporary = join(this.root, `current-${id}.tmp`);
		const file = await open(temporary, 'wx', 0o600);
		try { await file.writeFile(JSON.stringify({ format: FORMAT, generation: id })); await file.sync(); }
		finally { await file.close(); }
		await rename(temporary, join(this.root, 'current.json'));
		const directory = await open(this.root, 'r');
		try { await directory.sync(); } finally { await directory.close(); }
	}

	private async removeAbandoned(): Promise<void> {
		for (const entry of await readdir(join(this.root, 'generations'))) {
			if (GENERATION.test(entry) && entry !== this.active?.id) {
				await rm(join(this.root, 'generations', entry), { recursive: true, force: true });
			}
		}
	}

	private writable(id: string): KeywordIndex {
		const generation = [this.active, this.staging].find((entry) => entry?.id === id);
		if (!generation) throw new Error('The index generation has changed.');
		return generation.index;
	}

	async execute(request: SearchRequest): Promise<SearchReply['result']> {
		switch (request.type) {
			case 'semantic-snapshot': case 'semantic-begin': case 'semantic-commit': case 'semantic-abort':
			case 'semantic-apply': case 'semantic-remove': case 'semantic-vectors': case 'semantic-search':
				this.vectors ??= await VectorStore.open(join(this.root, 'semantic'), this.sdk);
				return await this.vectors.execute(request);
			case 'snapshot': return {
				generation: this.active?.id ?? '', notes: this.active ? await this.active.index.snapshot() : [], needsRebuild: this.needsRebuild,
			} satisfies IndexSnapshot;
			case 'begin-rebuild':
				if (this.staging) throw new Error('A rebuild is already in progress.');
				if (this.active) await this.removeAbandoned();
				this.staging = await this.createGeneration();
				return this.staging.id;
			case 'commit-rebuild': {
				if (this.staging?.id !== request.generation) throw new Error('The rebuild is no longer active.');
				await this.staging.index.maintain(true);
				await this.publish(this.staging.id);
				this.active?.index.close();
				this.active = this.staging;
				this.staging = undefined;
				this.needsRebuild = false;
				return null;
			}
			case 'abort-rebuild':
				if (this.staging?.id === request.generation) {
					this.staging.index.close();
					this.staging = undefined;
					await rm(join(this.root, 'generations', request.generation), { recursive: true, force: true });
				}
				return null;
			case 'apply': await this.writable(request.generation).apply(request.notes, request.removed); return null;
			case 'maintain': await this.writable(request.generation).maintain(); return null;
			case 'search':
				if (!this.active) throw new Error('Rebuild the incompatible keyword cache.');
				return await this.active.index.search(request.query);
			case 'snippets': return this.active ? await this.active.index.snippets(request.query, request.candidates) : [];
			case 'close': return null;
		}
	}

	close(): void { this.vectors?.close(); this.staging?.index.close(); this.active?.index.close(); }
}

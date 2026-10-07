import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SemanticRequest, SemanticResult, VectorSnapshot } from '../embeddings/types';
import type { LanceDB } from './global-sdk';
import { VectorGeneration } from './vector-generation';

interface Header { generation: string; space: string; dimensions: number }
interface Generation extends Header { index: VectorGeneration }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class VectorStore {
	private active?: Generation;
	private staging?: Generation;
	private needsRebuild = false;
	private constructor(private readonly root: string, private readonly sdk: LanceDB) {}
	static async open(root: string, sdk: LanceDB): Promise<VectorStore> {
		const store = new VectorStore(root, sdk);
		await mkdir(root, { recursive: true });
		let header: Header & { format: number };
		try { header = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) as typeof header; }
		catch (error) {
			store.needsRebuild = (error as NodeJS.ErrnoException).code !== 'ENOENT';
			return store;
		}
		try {
			if (header.format !== 1 || !UUID.test(header.generation) || !/^[a-f0-9]{64}$/.test(header.space)
				|| !Number.isInteger(header.dimensions) || header.dimensions < 1 || header.dimensions > 65536) throw new Error('Invalid semantic cache.');
			await stat(join(root, header.generation));
			store.active = { ...header, index: await VectorGeneration.open(join(root, header.generation), sdk, header.dimensions) };
			await store.cleanup();
		} catch { store.active?.index.close(); store.active = undefined; store.needsRebuild = true; }
		return store;
	}
	private async cleanup(): Promise<void> {
		for (const entry of await readdir(this.root)) {
			if (UUID.test(entry) && entry !== this.active?.generation) await rm(join(this.root, entry), { force: true, recursive: true });
		}
	}
	private writable(generation: string): Generation {
		const found = [this.active, this.staging].find((item) => item?.generation === generation);
		if (!found) throw new Error('The semantic generation changed.');
		return found;
	}
	async execute(request: SemanticRequest): Promise<SemanticResult> {
		switch (request.type) {
			case 'semantic-snapshot': return {
				generation: this.active?.generation ?? '', space: this.active?.space ?? '', dimensions: this.active?.dimensions ?? 0,
				notes: this.active ? await this.active.index.states() : [], needsRebuild: this.needsRebuild,
			} satisfies VectorSnapshot;
			case 'semantic-begin': {
				if (this.staging) throw new Error('A semantic rebuild is already running.');
				if (!/^[a-f0-9]{64}$/.test(request.space) || !Number.isInteger(request.dimensions) || request.dimensions < 1 || request.dimensions > 65536) throw new Error('Invalid vector space.');
				await this.cleanup();
				const generation = randomUUID();
				this.staging = { generation, space: request.space, dimensions: request.dimensions,
					index: await VectorGeneration.open(join(this.root, generation), this.sdk, request.dimensions) };
				return generation;
			}
			case 'semantic-commit': {
				if (this.staging?.generation !== request.generation) throw new Error('The semantic rebuild changed.');
				await this.staging.index.prepare();
				const { generation, space, dimensions } = this.staging;
				const temp = join(this.root, `current-${generation}.tmp`);
				const file = await open(temp, 'wx', 0o600);
				try { await file.writeFile(JSON.stringify({ format: 1, generation, space, dimensions })); await file.sync(); }
				finally { await file.close(); }
				await rename(temp, join(this.root, 'current.json'));
				const directory = await open(this.root, 'r');
				try { await directory.sync(); } finally { await directory.close(); }
				this.active?.index.close(); this.active = this.staging; this.staging = undefined; this.needsRebuild = false;
				return null;
			}
			case 'semantic-abort':
				if (this.staging?.generation === request.generation) {
					this.staging.index.close(); this.staging = undefined;
					await rm(join(this.root, request.generation), { recursive: true, force: true });
				}
				return null;
			case 'semantic-apply': await this.writable(request.generation).index.apply(request); return null;
			case 'semantic-remove': await this.writable(request.generation).index.remove(request.noteIds); return null;
			case 'semantic-vectors': return await this.writable(request.generation).index.vectors(request.noteId);
			case 'semantic-search':
				if (!this.active || this.active.space !== request.space) throw new Error('Build the semantic index for this model first.');
				return await this.active.index.search(request);
		}
	}
	close(): void { this.active?.index.close(); this.staging?.index.close(); }
}

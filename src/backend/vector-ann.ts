import type { Table } from '@lancedb/lancedb';
import type { LanceDB } from './global-sdk';
import { ANN_MAX_PARTITIONS } from './vector-config';

const INDEX_NAME = 'vector_idx';
const MAINTENANCE_ROWS = 1024;
const MAINTENANCE_WRITES = 128;
const PARTITIONS_KEY = 'obsidian:ann-partitions';
const partitionsFor = (rows: number) => Math.min(ANN_MAX_PARTITIONS, Math.max(1, Math.floor(Math.sqrt(rows))));

/** Keeps ANN construction separate from note writes and generation publication. */
export class VectorAnn {
	private pendingRows = 0;
	private writes = 0;
	private partitions = 0;
	private constructor(private readonly table: Table, private readonly sdk: LanceDB) {}
	static async open(table: Table, sdk: LanceDB): Promise<VectorAnn> {
		const ann = new VectorAnn(table, sdk);
		if ((await table.listIndices()).some((index) => index.name === INDEX_NAME)) {
			const stats = await table.indexStats(INDEX_NAME);
			ann.pendingRows = stats?.numUnindexedRows ?? 0;
			const saved = Number((await table.schema()).fields.find((field) => field.name === 'vector')?.metadata.get(PARTITIONS_KEY));
			if (stats?.indexType === 'IVF_FLAT' && stats.distanceType === 'cosine'
				&& Number.isInteger(saved) && saved >= 1 && saved <= ANN_MAX_PARTITIONS) ann.partitions = saved;
		}
		return ann;
	}
	async prepare(): Promise<void> {
		if (!this.partitions) {
			const rows = await this.table.countRows();
			if (!rows) return;
			await this.build(partitionsFor(rows));
		} else if (this.pendingRows >= MAINTENANCE_ROWS) await this.maintain();
	}
	private async build(partitions: number): Promise<void> {
		await this.table.createIndex('vector', { name: INDEX_NAME, replace: true,
			config: this.sdk.Index.ivfFlat({ distanceType: 'cosine', numPartitions: partitions }) });
		await this.table.updateFieldMetadata([{ path: 'vector', metadata: { [PARTITIONS_KEY]: String(partitions) } }]);
		this.partitions = partitions; this.pendingRows = 0; this.writes = 0;
	}
	async changed(rows: number, writes = 1): Promise<void> {
		this.pendingRows += rows; this.writes += writes;
		if (this.pendingRows >= MAINTENANCE_ROWS || this.writes >= MAINTENANCE_WRITES) await this.maintain();
	}
	private async maintain(): Promise<void> {
		// Incorporates unindexed rows when an index exists; compacts staging writes
		// otherwise. Small tails remain searchable through LanceDB's normal query.
		await this.table.optimize();
		this.pendingRows = 0; this.writes = 0;
		// Retrain locally after substantial growth so an index created for a tiny
		// vault does not keep its original partition count forever.
		if (this.partitions) {
			const partitions = partitionsFor(await this.table.countRows());
			if (partitions >= this.partitions * 2) await this.build(partitions);
		}
	}
}

import type { Connection, Table } from '@lancedb/lancedb';
import type { LanceDB } from './global-sdk';

const ICU = {
	baseTokenizer: 'icu' as const,
	lowercase: true,
	stem: false,
	removeStopWords: false,
	withPosition: true,
};

export async function probeDatabase(directory: string, sdk: LanceDB): Promise<string[]> {
	let connection: Connection = await sdk.connect(directory);
	let table: Table | undefined;
	const checks: string[] = [];
	try {
		table = await connection.createTable('probe', [
			{ id: 'mixed', body: '本地笔记搜索 Local SEARCH running the' },
			{ id: 'other', body: 'An unrelated document about music' },
		]);
		await table.createIndex('body', { config: sdk.Index.fts(ICU) });
		checks.push('create-icu-fts');
		for (const query of ['笔记', 'search', 'running', 'the']) {
			const rows = await table.search(query, 'fts', ['body']).limit(10).toArray() as { id: string }[];
			if (!rows.some((row) => row.id === 'mixed')) throw new Error('ICU FTS probe failed.');
		}
		const stemmed = await table.search('run', 'fts', ['body']).limit(10).toArray();
		if (stemmed.length !== 0) throw new Error('Stemming was not disabled.');
		checks.push('chinese', 'lowercase', 'no-stemming', 'keep-stop-words');
		table.close();
		table = undefined;
		connection.close();
		connection = await sdk.connect(directory);
		table = await connection.openTable('probe');
		const reopened = await table.search('"local search"', 'fts', ['body']).toArray() as { id: string }[];
		if (reopened.length !== 1 || reopened[0]?.id !== 'mixed') {
			throw new Error('Reopened ICU phrase index did not return the expected row.');
		}
		checks.push('close-and-reopen', 'phrase-positions');
		return checks;
	} finally {
		table?.close();
		connection.close();
	}
}

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tooling only: load the same TypeScript used by the plugin without a second implementation.
export async function loadSource(entry) {
	const temporary = await mkdtemp(join(tmpdir(), 'lancedb-source-'));
	try {
		const output = join(temporary, 'source.mjs');
		await build({ entryPoints: [resolve(entry)], outfile: output, bundle: true, platform: 'node', format: 'esm' });
		// This path is generated above in a fresh private temp directory, not supplied by content.
		// eslint-disable-next-line no-unsanitized/method -- Import only the locally generated module above.
		return await import(pathToFileURL(output).href);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

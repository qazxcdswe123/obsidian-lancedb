import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type LanceDB = typeof import('@lancedb/lancedb');

export async function loadGlobalLanceDB(globalModulesPath: string): Promise<{ sdk: LanceDB; version: string; entry: string }> {
	if (!isAbsolute(globalModulesPath)) throw new Error('The global modules path must be absolute.');
	const directory = join(globalModulesPath, '@lancedb/lancedb');
	const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string };
	if (metadata.name !== '@lancedb/lancedb' || typeof metadata.version !== 'string') {
		throw new Error('Invalid global LanceDB package.');
	}
	// Resolve this exact global installation. Never use the plugin's node_modules or NODE_PATH.
	const entry = createRequire(__filename).resolve(directory);
	// eslint-disable-next-line no-unsanitized/method -- Load the explicitly selected local npm installation, never note content or a URL.
	const module = await import(pathToFileURL(entry).href) as LanceDB;
	if (typeof module.connect !== 'function' || typeof module.Index?.fts !== 'function') {
		throw new Error('The installed LanceDB does not expose the required search API.');
	}
	return { sdk: module, version: metadata.version, entry };
}

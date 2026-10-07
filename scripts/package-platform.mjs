import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('Build the macOS Apple Silicon prototype on macOS arm64.');
}
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const destination = resolve('dist', manifest.id);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const entry of ['main.js', 'search-host.cjs']) {
	const metadata = JSON.parse(await readFile(`dist/${entry}.meta.json`, 'utf8'));
	if (Object.keys(metadata.inputs).some((input) => input.includes('node_modules/'))) {
		throw new Error('The prototype must use the global SDK, without bundling development dependencies.');
	}
	for (const output of Object.values(metadata.outputs)) {
		for (const dependency of output.imports.filter((item) => item.external)) {
			const name = dependency.path.replace(/^node:/, '');
			if (!builtinModules.includes(name) && !(entry === 'main.js' && name === 'obsidian')) {
				throw new Error(`Unexpected runtime dependency: ${dependency.path}`);
			}
		}
	}
}

const files = {};
for (const name of ['main.js', 'search-host.cjs', 'manifest.json', 'styles.css', 'LICENSE']) {
	await cp(name, join(destination, name));
	const bytes = await readFile(join(destination, name));
	files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile(join(destination, 'resources.json'), JSON.stringify({
	format: 2, pluginVersion: manifest.version, platform: 'darwin-arm64', dependencyMode: 'global-npm', files,
}, null, 2) + '\n');
const archive = resolve('dist', `${manifest.id}-${manifest.version}-darwin-arm64.zip`);
execFileSync('ditto', ['-c', '-k', '--keepParent', '--norsrc', destination, archive]);
console.log(JSON.stringify({ destination, archive, bytes: Object.values(files).reduce((sum, item) => sum + item.bytes, 0) }, null, 2));

import esbuild from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const prod = process.argv[2] === 'production';
const entries = [
	{ entryPoints: ['src/main.ts'], outfile: 'main.js', external: ['obsidian'] },
	{ entryPoints: ['src/search-host.ts'], outfile: 'search-host.cjs' },
];

if (prod) await mkdir('dist', { recursive: true });
for (const entry of entries) {
	const options = {
		...entry, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
		logLevel: 'info', sourcemap: prod ? false : 'inline', minify: prod, metafile: true,
	};
	if (prod) {
		const result = await esbuild.build(options);
		await writeFile(`dist/${entry.outfile}.meta.json`, JSON.stringify(result.metafile, null, 2));
	} else {
		const context = await esbuild.context(options);
		await context.watch();
	}
}

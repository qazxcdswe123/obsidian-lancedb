import { loadSource } from './load-source.mjs';

const { resolveGlobalRuntime } = await loadSource('src/runtime/global-runtime.ts');
const runtime = await resolveGlobalRuntime({ nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' });
console.log(JSON.stringify({
	...runtime,
	dependencyMode: 'global-npm',
	installCommand: 'npm install -g @lancedb/lancedb@latest',
	next: 'Run the native check to verify this installed version.',
}, null, 2));

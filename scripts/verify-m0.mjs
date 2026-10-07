import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSource } from './load-source.mjs';

const { resolveGlobalRuntime } = await loadSource('src/runtime/global-runtime.ts');
const runtime = await resolveGlobalRuntime({ nodePath: process.argv[2] ?? '', globalModulesPath: process.argv[3] ?? '' });
const { verifyResources } = await loadSource('src/runtime/resources.ts');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'lancedb-m0-'));

function runProbe(directory, action = 'normal', modules = runtime.globalModulesPath) {
	return new Promise((resolveProbe, reject) => {
		const requestId = randomUUID();
		const child = spawn(runtime.nodePath, [join(directory, 'search-host.cjs'), join(directory, 'cache'), requestId, modules], {
			cwd: directory, env: { PATH: '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		});
		let report;
		let ready = false;
		let failure;
		const timeout = setTimeout(() => {
			failure = new Error('Probe timed out.');
			child.kill('SIGKILL');
		}, 30_000);
		child.on('message', (message) => {
			if (message.requestId !== requestId) return;
			if (message.phase === 'ready') {
				ready = true;
				if (action === 'crash') child.kill('SIGKILL');
				if (action === 'disconnect') child.disconnect();
			}
			if (message.result) report = message.result;
			if (message.error) failure = new Error(message.error);
		});
		child.once('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		// Node can emit exit without close after an explicit IPC disconnect.
		child.once('exit', (code, signal) => {
			clearTimeout(timeout);
			if (failure) return reject(failure);
			if (action !== 'normal') {
				if (ready && (code !== 0 || signal)) return resolveProbe();
				return reject(new Error('Expected an isolated child exit after native loading.'));
			}
			if (code !== 0 || !report) return reject(new Error(`Probe failed (${code}).`));
			resolveProbe(report);
		});
	});
}

try {
	const executableFixture = join(temporary, 'executable-directory');
	await mkdir(join(executableFixture, 'node'), { recursive: true });
	const previousPath = process.env.PATH;
	try {
		process.env.PATH = `${executableFixture}:${previousPath ?? ''}`;
		assert.equal((await resolveGlobalRuntime({ nodePath: '', globalModulesPath: runtime.globalModulesPath })).nodeVersion, runtime.nodeVersion);
	} finally {
		process.env.PATH = previousPath;
	}
	const explicit = await resolveGlobalRuntime({ nodePath: runtime.nodePath, globalModulesPath: runtime.globalModulesPath });
	assert.equal(explicit.sdkVersion, runtime.sdkVersion);
	await assert.rejects(resolveGlobalRuntime({ nodePath: 'relative/node', globalModulesPath: '' }), /absolute/);
	await assert.rejects(resolveGlobalRuntime({ nodePath: runtime.nodePath, globalModulesPath: temporary }), /not found/);
	// A newer installed version is reported as installed, without an exact-version gate.
	const fixture = join(temporary, 'future modules/@lancedb/lancedb');
	await mkdir(fixture, { recursive: true });
	await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: '@lancedb/lancedb', version: '99.0.0', engines: { node: '>=22' } }));
	assert.equal((await resolveGlobalRuntime({ nodePath: runtime.nodePath, globalModulesPath: join(temporary, 'future modules') })).sdkVersion, '99.0.0');
	console.log('PASS: global discovery, explicit paths, missing installation, no SDK version pin');

	const extracted = join(temporary, '中文 空格');
	await mkdir(extracted);
	execFileSync('ditto', ['-x', '-k', resolve(`dist/${manifest.id}-${manifest.version}-darwin-arm64.zip`), extracted]);
	const directory = join(extracted, manifest.id);
	const packagedFiles = await readdir(directory);
	assert.equal(packagedFiles.includes('node_modules'), false);
	assert.equal(packagedFiles.includes('native'), false);
	assert.equal(packagedFiles.includes('runtime'), false);
	await verifyResources(directory, manifest.version);
	await assert.rejects(verifyResources(directory, 'wrong-version'), /version does not match/);
	const report = await runProbe(directory);
	assert.equal(report.sdkVersion, runtime.sdkVersion);
	assert.ok(report.sdkEntry.startsWith(join(runtime.globalModulesPath, '@lancedb/lancedb/')));
	assert.equal(report.arch, 'arm64');
	assert.deepEqual(report.checks, ['create-icu-fts', 'chinese', 'lowercase', 'no-stemming', 'keep-stop-words', 'close-and-reopen', 'phrase-positions']);
	assert.deepEqual(await readdir(join(directory, 'cache')), []);
	console.log('PASS: global SDK, no packaged native resources, empty PATH, ICU, reopen, cleanup');
	await assert.rejects(runProbe(directory, 'normal', temporary), /Could not load global/);
	await assert.rejects(runProbe(directory, 'normal', join(temporary, 'future modules')), /Could not load global/);
	console.log('PASS: missing/incompatible global SDK fails without using development dependencies');
	await runProbe(directory, 'crash');
	await runProbe(directory, 'disconnect');
	await runProbe(directory);
	console.log('PASS: child crash, IPC disconnect exit, fresh process');
	await appendFile(join(directory, 'search-host.cjs'), '\n// corrupted fixture\n');
	await assert.rejects(verifyResources(directory, manifest.version), /integrity/);
	console.log('PASS: plugin resource tampering rejected');
	console.log(JSON.stringify({ environment: 'standalone-node-with-global-npm', runtime, report }, null, 2));
} finally {
	await rm(temporary, { recursive: true, force: true });
}

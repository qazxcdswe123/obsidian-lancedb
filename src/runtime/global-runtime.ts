import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { RuntimeSettings } from '../settings';

export interface GlobalRuntime {
	nodePath: string;
	nodeVersion: string;
	globalModulesPath: string;
	sdkVersion: string;
	nodeRequirement: string;
}

function environment(nodePath: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: [dirname(nodePath), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter),
	};
	// npm needs the user's configuration to honor a custom global prefix.
	for (const name of ['HOME', 'TMPDIR', 'NPM_CONFIG_PREFIX', 'npm_config_prefix']) {
		if (process.env[name]) env[name] = process.env[name];
	}
	return env;
}

function capture(executable: string, args: string[], nodePath: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(executable, args, {
			env: environment(nodePath), timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal,
		}, (error, stdout) => {
			if (error) reject(new Error('Could not check Node.js or npm. Set their installation paths in the plugin settings.'));
			else resolve(stdout.trim());
		});
	});
}

async function findExecutable(name: string, preferredDirectory?: string): Promise<string> {
	const directories = [preferredDirectory, ...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
	for (const directory of new Set(directories)) {
		if (!directory || !isAbsolute(directory)) continue;
		const candidate = join(directory, name);
		try {
			if (!(await stat(candidate)).isFile()) continue;
			await access(candidate, constants.X_OK);
			return candidate;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') throw error;
		}
	}
	throw new Error(`Could not find ${name}. Install Node.js with npm, then set the paths in the plugin settings.`);
}

export async function resolveGlobalRuntime(settings: RuntimeSettings, signal?: AbortSignal): Promise<GlobalRuntime> {
	if (process.platform !== 'darwin' || process.arch !== 'arm64') {
		throw new Error('This prototype supports macOS on Apple Silicon only.');
	}
	const nodePath = settings.nodePath || await findExecutable('node');
	if (!isAbsolute(nodePath)) throw new Error('The Node.js executable path must be absolute.');
	const nodeVersion = await capture(nodePath, ['--version'], nodePath, signal);
	if (!/^v\d+\.\d+\.\d+$/.test(nodeVersion) || Number(nodeVersion.slice(1).split('.')[0]) < 22) {
		throw new Error('Select a Node.js installation of version 22 or newer that supports the installed LanceDB package.');
	}
	let globalModulesPath = settings.globalModulesPath;
	if (!globalModulesPath) {
		const npm = await findExecutable('npm', dirname(nodePath));
		globalModulesPath = await capture(npm, ['root', '--global'], nodePath, signal);
	}
	if (!isAbsolute(globalModulesPath) || /[\r\n]/.test(globalModulesPath)) {
		throw new Error('Set the global modules directory to the absolute path printed by npm root -g.');
	}
	let metadata: { name?: string; version?: string; engines?: { node?: string } };
	try {
		metadata = JSON.parse(await readFile(join(globalModulesPath, '@lancedb/lancedb/package.json'), 'utf8')) as typeof metadata;
	} catch {
		throw new Error('LanceDB was not found in the global modules directory. Run npm install -g @lancedb/lancedb@latest.');
	}
	if (metadata.name !== '@lancedb/lancedb' || typeof metadata.version !== 'string') {
		throw new Error('The global LanceDB installation is invalid. Run npm install -g @lancedb/lancedb@latest.');
	}
	return { nodePath, nodeVersion, globalModulesPath, sdkVersion: metadata.version, nodeRequirement: metadata.engines?.node ?? 'Not specified by the installed package' };
}

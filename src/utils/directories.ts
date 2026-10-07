export function normalizeDirectories(value: string): string[] {
	return [...new Set(value.split('\n').map((path) => path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
		.filter((path) => path && !path.split('/').some((part) => part === '..' || part === '.')))];
}

import { randomUUID } from 'node:crypto';

interface LocalStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

export function deviceId(storage: LocalStorage): string {
	const key = 'lancedb-search-device-id';
	const existing = storage.loadLocalStorage(key);
	if (typeof existing === 'string' && /^[a-f0-9-]{36}$/.test(existing)) return existing;
	const id = randomUUID();
	storage.saveLocalStorage(key, id);
	return id;
}

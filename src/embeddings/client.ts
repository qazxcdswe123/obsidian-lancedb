import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { embeddingUrl, type EmbeddingConfig } from './settings';

export interface HttpResponse { status: number; json: unknown }
export type EmbeddingTransport = (request: { url: string; method: string; headers: Record<string, string>; body: string; throw: boolean }) => Promise<HttpResponse>;
export class EmbeddingError extends Error {
	constructor(message: string, readonly kind: 'cancelled' | 'timeout' | 'busy' | 'transient' | 'permanent') { super(message); }
}

export function validateVectors(value: unknown, count: number, dimensions?: number): number[][] {
	const data = (value as { data?: unknown } | null)?.data;
	if (!Array.isArray(data) || data.length !== count) throw new EmbeddingError('The embedding response has an incorrect result count.', 'permanent');
	const result: number[][] = new Array<number[]>(count);
	for (const item of data as { index?: unknown; embedding?: unknown }[]) {
		const index = item?.index;
		const vector = item?.embedding;
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || result[index]
			|| !Array.isArray(vector) || !vector.length || vector.length > 65536
			|| !vector.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 3.4e38)
			|| !vector.some((n: number) => n !== 0)) {
			throw new EmbeddingError('The embedding response contains invalid indices or vectors.', 'permanent');
		}
		dimensions ??= vector.length;
		if (vector.length !== dimensions) throw new EmbeddingError('The embedding dimensions changed. Test the connection and rebuild the semantic index.', 'permanent');
		result[index] = vector as number[];
	}
	return result;
}

export class EmbeddingClient {
	private inFlight = 0;
	constructor(private readonly transport: EmbeddingTransport, private readonly secret: (name: string) => string | null) {}

	async embed(config: EmbeddingConfig, input: string[], signal: AbortSignal, current: () => boolean, dimensions?: number): Promise<number[][]> {
		for (let attempt = 0; ; attempt++) {
			this.check(signal, current);
			try { return await this.send(config, input, signal, current, dimensions); }
			catch (error) {
				if (!(error instanceof EmbeddingError) || error.kind !== 'transient' || attempt >= 2) throw error;
				try { await delay(attempt === 0 ? 500 : 1500, undefined, { signal }); }
				catch { throw new EmbeddingError('Remote work stopped.', 'cancelled'); }
			}
		}
	}

	private check(signal: AbortSignal, current: () => boolean): void {
		if (signal.aborted || !current()) throw new EmbeddingError('Remote work stopped.', 'cancelled');
	}
	private async send(config: EmbeddingConfig, input: string[], signal: AbortSignal, current: () => boolean, dimensions?: number): Promise<number[][]> {
		const url = embeddingUrl(config);
		const key = this.secret(config.secretName);
		if (!key) throw new EmbeddingError('The selected API key is missing from secret storage.', 'permanent');
		this.check(signal, current);
		if (this.inFlight >= config.concurrency) throw new EmbeddingError('Remote requests are still running. Wait before retrying.', 'busy');
		this.inFlight++;
		// A timeout releases the caller, not the underlying requestUrl connection.
		// Keep its slot occupied until settlement so retries cannot accumulate.
		const pending = Promise.resolve().then(() => {
			this.check(signal, current);
			return this.transport({ url, method: 'POST', throw: false,
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: config.model, input, encoding_format: 'float', ...(config.dimensions == null ? {} : { dimensions: config.dimensions }) }),
			});
		}).catch((error: unknown) => {
			if (error instanceof EmbeddingError) throw error;
			throw new EmbeddingError('Could not reach the embedding service.', 'transient');
		}).finally(() => { this.inFlight--; });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort = () => {};
		try {
			const response = await Promise.race([pending, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new EmbeddingError('The embedding request timed out. It may still be running remotely.', 'timeout')), config.timeoutMs);
				abort = () => reject(new EmbeddingError('Remote work stopped.', 'cancelled'));
				signal.addEventListener('abort', abort, { once: true });
				if (signal.aborted) abort();
			})]);
			this.check(signal, current);
			if (response.status < 200 || response.status >= 300) {
				throw new EmbeddingError(`The embedding service returned HTTP ${response.status}. Check the connection settings.`,
					response.status === 429 || response.status >= 500 ? 'transient' : 'permanent');
			}
			return validateVectors(response.json, input.length, dimensions ?? config.dimensions ?? undefined);
		} finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
	}
}

export function row(noteId, vector, extra = {}) {
	return { noteId, path: `Notes/${noteId}.md`, version: 'v1', title: noteId, sourceHash: 'hash', tagFilter: '\nkeep\n',
		chunkId: `${noteId}:0`, inputHash: 'input', start: 0, end: 7, snippet: 'passage', vector, empty: 0, ...extra };
}

export function seededRandom(seed) {
	return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

export function unit(vector) {
	const norm = Math.hypot(...vector);
	return vector.map((value) => value / norm);
}

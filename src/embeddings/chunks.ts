import { contentHash } from '../indexing/document';
import type { NoteDocument } from '../search/types';
import type { TextChunk } from './types';

// Offsets always refer to the original UTF-16 Markdown. Heading context is
// derived only from the body, never from filenames or frontmatter.
export function chunkNote(note: NoteDocument, maxChars: number): TextChunk[] {
	const chunks: TextChunk[] = [];
	const headings: string[] = [];
	let offset = 0;
	let fence = '';
	let start = 0;
	let context = '';
	const flush = (end: number) => {
		for (let from = start; from < end;) {
			let to = Math.min(end, from + maxChars);
			if (to < end && /[\uD800-\uDBFF]/.test(note.body[to - 1]!)) to--;
			const text = note.body.slice(from, to);
			if (text.trim()) {
				const input = context ? `${context}\n\n${text}` : text;
				chunks.push({ input, inputHash: contentHash(input), start: note.bodyStart + from,
					end: note.bodyStart + to, snippet: text.trim().slice(0, 240) });
			}
			from = to;
		}
		start = end;
	};
	for (const block of note.body.matchAll(/[^\n]*(?:\n|$)/g)) {
		const line = block[0];
		if (!line) continue;
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
		}
		const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			flush(offset);
			headings.length = heading[1]!.length - 1; headings.push(heading[2]!);
			context = headings.filter(Boolean).join(' > ').slice(0, 600);
		}
		offset += line.length;
		if (!line.trim() || offset - start >= maxChars) flush(offset);
	}
	flush(note.body.length);
	return chunks;
}

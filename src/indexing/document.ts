import { createHash } from 'node:crypto';
import type { NoteDocument } from '../search/types';

export function contentHash(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

export function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function strings(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// Keep expansions out of natural text so they cannot create phrase positions.
function expandIdentifiers(text: string): string {
	const words = text.match(/[A-Za-z][A-Za-z0-9_.-]*/g) ?? [];
	return words.map((word) => word
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_.-]+/g, ' ')).join(' ');
}

function inlineTags(body: string): string[] {
	let fence = '';
	const tags: string[] = [];
	for (const line of body.split('\n')) {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
			continue;
		}
		if (fence) continue;
		const text = line.replace(/`[^`]*`/g, '');
		for (const match of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
			if (match[1]) tags.push(match[1]);
		}
	}
	return tags;
}

export function extractDocument(input: {
	noteId: string; path: string; content: string; bodyStart: number; frontmatter: Record<string, unknown>;
}): NoteDocument {
	const { noteId, path, content, bodyStart, frontmatter } = input;
	const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
	const body = content.slice(bodyStart);
	const aliases = [...new Set([...strings(frontmatter.aliases), ...strings(frontmatter.alias)])];
	const tags = [...new Set([
		...strings(frontmatter.tags).flatMap((tag) => tag.split(/[ ,]+/)),
		...strings(frontmatter.tag), ...inlineTags(body),
	].map((tag) => tag.replace(/^#/, '').toLowerCase()).filter(Boolean))];
	return {
		noteId, path, title, aliases, tags, body, bodyStart,
		sourceHash: contentHash(content),
		version: contentHash(JSON.stringify([1, path, content, aliases, tags])),
		identifiers: expandIdentifiers([title, ...aliases, body].join('\n')),
	};
}

export function isExcluded(path: string, directories: string[]): boolean {
	return directories.some((directory) => path === directory || path.startsWith(`${directory}/`));
}

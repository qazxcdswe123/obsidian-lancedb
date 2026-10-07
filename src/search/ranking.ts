import { normalizeText } from '../indexing/document';
import type { NoteDocument, SearchCandidate, SearchHit } from './types';
import { phrasePattern, type QueryPlan } from './query';

export function rankNote(note: Pick<NoteDocument, 'noteId' | 'path' | 'version' | 'sourceHash' | 'title' | 'aliases'>, plan: QueryPlan, relevance: number): SearchCandidate {
	const title = normalizeText(note.title);
	const aliases = note.aliases.map(normalizeText);
	const exact = plan.text && (title === plan.text || aliases.includes(plan.text));
	const titleMatches = [...plan.terms, ...plan.phrases].filter((term) => title.includes(normalizeText(term))).length;
	const aliasMatches = [...plan.terms, ...plan.phrases].filter((term) => aliases.some((alias) => alias.includes(normalizeText(term)))).length;
	// Keep native relevance bounded so exact names always precede body-only matches.
	const score = (exact ? 1000 : 0) + titleMatches * 20 + aliasMatches * 10 + relevance / (1 + Math.abs(relevance));
	return { noteId: note.noteId, path: note.path, version: note.version, sourceHash: note.sourceHash, title: note.title, score };
}

export function createSnippet(note: Pick<NoteDocument, 'body' | 'bodyStart'>, candidate: SearchCandidate, plan: QueryPlan): SearchHit {
	const needles = [...plan.phrases, ...plan.terms];
	let best = { offset: 0, length: 0, matches: 0 };
	let offset = 0;
	for (const line of note.body.split('\n')) {
		const matches = needles.map((term) => phrasePattern(term).exec(line)).filter((match) => match !== null);
		if (matches.length > best.matches) {
			const first = matches[0]!;
			best = { offset: offset + first.index, length: first[0].length, matches: matches.length };
		}
		offset += line.length + 1;
	}
	for (const phrase of plan.phrases) {
		const match = phrasePattern(phrase).exec(note.body);
		if (match && best.matches <= 1) best = { offset: match.index, length: match[0].length, matches: 1 };
	}
	const snippetStart = Math.max(0, best.offset - 65);
	return {
		...candidate,
		snippet: note.body.slice(snippetStart, snippetStart + 220).replace(/\s+/g, ' ').trim(),
		start: note.bodyStart + best.offset, end: note.bodyStart + best.offset + best.length,
	};
}

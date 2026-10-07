import type { SemanticRequest, SemanticResult } from '../embeddings/types';

export interface NoteDocument {
	noteId: string;
	path: string;
	version: string;
	sourceHash: string;
	title: string;
	aliases: string[];
	tags: string[];
	body: string;
	bodyStart: number;
	identifiers: string;
}

export type NoteState = Pick<NoteDocument, 'noteId' | 'path' | 'version'>;

export interface SearchCandidate extends NoteState {
	title: string;
	sourceHash: string;
	score: number;
}

export interface SearchHit extends SearchCandidate {
	snippet: string;
	start: number;
	end: number;
}

export interface SearchResponse {
	hits: SearchHit[];
	total: number;
}

export interface SearchMatches { hits: SearchCandidate[]; total: number }
export interface IndexSnapshot { generation: string; notes: NoteState[]; needsRebuild: boolean }

export type SearchRequest =
	| SemanticRequest
	| { type: 'snapshot' }
	| { type: 'apply'; generation: string; notes: NoteDocument[]; removed: string[] }
	| { type: 'search'; query: string }
	| { type: 'snippets'; query: string; candidates: SearchCandidate[] }
	| { type: 'begin-rebuild' }
	| { type: 'commit-rebuild'; generation: string }
	| { type: 'abort-rebuild'; generation: string }
	| { type: 'maintain'; generation: string }
	| { type: 'close' };

export interface SearchReply {
	requestId: string;
	result?: IndexSnapshot | SearchMatches | SearchHit[] | SemanticResult | string | null;
	error?: string;
}

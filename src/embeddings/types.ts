import type { NoteState, SearchHit } from '../search/types';
import type { SemanticScope } from './settings';

export interface TextChunk { input: string; inputHash: string; start: number; end: number; snippet: string }
export interface EmbeddedChunk extends Omit<TextChunk, 'input'> { vector: number[] }
export interface VectorSnapshot {
	generation: string; space: string; dimensions: number; notes: NoteState[]; needsRebuild: boolean;
}
export interface CachedVector { inputHash: string; vector: number[] }
export type SemanticRequest =
	| { type: 'semantic-snapshot' }
	| { type: 'semantic-begin'; space: string; dimensions: number }
	| { type: 'semantic-commit' | 'semantic-abort'; generation: string }
	| { type: 'semantic-apply'; generation: string; note: NoteState & { title: string; sourceHash: string; tags: string[] }; chunks: EmbeddedChunk[] }
	| { type: 'semantic-remove'; generation: string; noteIds: string[] }
	| { type: 'semantic-vectors'; generation: string; noteId: string }
	| { type: 'semantic-search'; space: string; vector: number[]; query: string; scope: SemanticScope; excludeNoteIds: string[] };
export type SemanticResult = VectorSnapshot | CachedVector[] | SearchHit[] | string | null;

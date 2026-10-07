// Bundle integration participants together so errors retain class identity.
export { SearchClient } from '../src/runtime/search-client.ts';
export { IndexCoordinator } from '../src/indexing/coordinator.ts';
export { extractDocument } from '../src/indexing/document.ts';
export { SemanticEngine } from '../src/embeddings/engine.ts';
export { EmbeddingClient, validateVectors } from '../src/embeddings/client.ts';
export { loadEmbeddingSettings, configurationKey, vectorSpace, restrictScope } from '../src/embeddings/settings.ts';
export { chunkNote } from '../src/embeddings/chunks.ts';
export { fuseResults } from '../src/search/fusion.ts';
export { acquireWriterLock } from '../src/backend/writer-lock.ts';

# LanceDB search

Markdown search for Obsidian on macOS Apple Silicon, with local Chinese/English keyword search and optional remote semantic search. Includes saved-note updates, filters, source navigation, crash recovery, and rebuilding without interrupting the existing index. M0–M3 are implemented for personal use through manual installation; see [docs/PLAN.md](docs/PLAN.md) for scope and [M3 validation](docs/M3-VALIDATION.md) for the tested remote contract. Related notes (M4) are not implemented.

## Install

Install Node.js with npm, then install the latest global LanceDB package:

```sh
npm install -g @lancedb/lancedb@latest
```

Use Obsidian 1.13.7 or newer and Node.js 22 or newer, also satisfying the installed package's Node requirement. npm installs the native library and peer dependencies, including Arrow. No separate database service is needed. The plugin does not bundle Node, LanceDB, Arrow, or native binaries.

1. Fully quit Obsidian.
2. Extract the plugin ZIP into `<Vault>/.obsidian/plugins/`, producing `lancedb-search/`.
3. Enable **LanceDB search** in **Settings → Community plugins**.
4. Open **Settings → LanceDB search → Check environment**, then select **Check native search**.
5. Run **LanceDB search: Search notes** from the command palette. The first search builds the local index.

The plugin detects Node from PATH or the standard Homebrew locations and obtains the global modules directory with `npm root -g`. Finder-launched apps and Node version managers can have a different PATH from your terminal. If detection fails, run:

```sh
command -v node
npm root -g
```

Copy the outputs into **Node.js executable** and **Global modules directory** in the plugin settings. These settings persist in `data.json`. Reload the plugin after changing runtime paths. Saving them does not install packages, load native code, or contact a remote service.

The package contains `main.js`, `search-host.cjs`, `manifest.json`, `styles.css`, `resources.json`, and `LICENSE`. Copying only the standard community-plugin files is insufficient because the background entry point is also required.

## Global version updates

Install and update with the same command, `npm install -g @lancedb/lancedb@latest`. No SDK version is pinned or checked against an exact allowlist. The plugin uses the version currently installed in the selected global directory; it does not fetch updates automatically or modify that installation.

Quit Obsidian before updating the global package, then reopen it and run **Check environment** again. The check displays the installed SDK and Node versions and validates the required native search behavior. A future `latest` that changes the required API or native compatibility will fail this check with an actionable message; it will not silently load a development or older copy. Multiple vaults using the same global directory share the dependency version, while their databases remain separate.

## What the diagnostic does

The command **LanceDB search: Check search runtime** checks the selected Node executable and global package. **Check native search** then starts an isolated Node process, loads that exact global SDK, builds an ICU text index from built-in sample text, queries it, closes and reopens it, and removes its temporary data. No notes are read, modified, or sent; no embedding service is configured. Closing the modal or disabling the plugin cancels the check and cleans its temporary directory after the child exits.

This mode does not use Electron's `runAsNode` fuse. The minimum Obsidian version is now the verified host version, 1.13.7; earlier versions are not claimed as supported. Runtime evidence is in [docs/M0-VALIDATION.md](docs/M0-VALIDATION.md) and [docs/M2-VALIDATION.md](docs/M2-VALIDATION.md).

## Search notes

Search covers the filename title, frontmatter `aliases`/`alias`, frontmatter and inline tags, and the Markdown body, including code. Other frontmatter values are not searched. Title and alias exact matches rank first; each note appears once. The result count covers all current matches, with the first 50 displayed. Use the arrow keys and Enter, or select a result, to open its matching source text.

| Query | Meaning |
| --- | --- |
| `笔记 search` | Both terms must occur in the same note, including across fields or paragraphs |
| `"local search"` | A phrase within one source field; whitespace can span lines |
| `search path:"Project notes"` | Search within paths containing `Project notes`, ignoring case |
| `search tag:research/中文` | Search notes with that exact tag; the leading `#` is optional |
| `user name` | Also finds identifier components such as `getUserName` |

Multiple path or tag filters must all match. Quoted phrases do not match across separate aliases or across a title/body boundary. Camel-case and separator expansion supports ordinary terms, but does not create synthetic phrase matches. This is a separate query language from Obsidian's built-in search.

Configure **Excluded directories** before the first search to omit local folders. Entries are vault-relative paths, one per line, including their descendants. Changing exclusions invalidates old results immediately and updates the local index. Keyword queries and keyword indexing use no remote service. A result whose file changed is rejected or opened without an outdated selection; search again to refresh it.

The background process starts when search or rebuild is first used. Startup then reconciles saved Markdown asynchronously; indexing progress appears in the modal. Saving, creating, renaming, and deleting notes update the index. **Rebuild keyword index** writes a separate database generation and switches after completion, preserving the current search index, notes, and settings. Edits during rebuilding update both generations. An interrupted rebuild is discarded on the next start.

After an unexpected search-process exit, the plugin restarts and reconciles the saved notes, with a limit of two automatic attempts per plugin session. Repeated failures stop search and ask you to check the environment and reload the plugin. Disabling the plugin cancels a pending restart. Startup failures such as missing dependencies or an occupied cache are not retried automatically.

The 10,000-note benchmark now measures about 32 ms backend p95 for a broad term query, including its first 50 snippets. This covers a synthetic corpus and specific queries, not all workloads or human relevance. Current evidence and limitations are in [docs/M2-VALIDATION.md](docs/M2-VALIDATION.md).

## Optional semantic search

Remote calls are off by default. In **Settings → LanceDB search → Remote semantic search**:

1. Enter your embedding **API base URL**, including its version path, and **Model ID**. The plugin appends `/embeddings` and uses the OpenAI-compatible Bearer JSON contract. Use HTTPS for remote providers.
2. Select or create an **API key** in Obsidian SecretStorage. `data.json` stores only the secret name. Leave **Dimensions** empty unless your provider supports requesting a specific value.
3. Choose **Included directories** or explicitly enable **Include all Markdown**. Local exclusions always apply; **Semantic exclusions** can narrow the scope further.
4. Select **Test connection**. This sends two built-in public sentences, checks the response, and confirms the actual dimension; it sends no notes.
5. Select **Build semantic index**, review the provider and note count, then select **Start sending and build**. This sends body passages and body headings from the selected scope. New and changed notes in that scope update automatically, including after a plugin restart. Unchanged passages reuse their vectors.

Requests do not add filenames, paths, frontmatter, or tag metadata. The body itself may contain private information, which is sent as part of its passages. The selected provider receives this text and submitted query text and may charge for requests. Secrets, request headers, and note text are not logged. Set passage length and batch size to match your provider's limits; character counts are not token counts. No provider is preconfigured.

In **Search notes**, select **Semantic** or **Hybrid** and press Enter in the input or select **Search** to send the query. Typing, changing modes, and index updates do not send queries. `path:` and `tag:` filters stay local. Semantic matches need not contain the exact words or quoted phrase. Results are grouped by note and show the best retrieved passage; hybrid search combines the ranks of up to 50 keyword and 50 semantic candidates. Semantic and hybrid counts describe returned candidates, not every potential match.

Semantic retrieval uses a local **IVF_FLAT ANN index with cosine distance**. Scope, path, tag, and known stale-note filters apply before candidate selection. Each query returns up to 50 notes, with bounded additional batches when multiple passages belong to the same note. Approximate search can miss neighbors. Existing vector caches gain the ANN index on their first semantic search, using saved vectors without resending notes; that first search may take longer. New generations build ANN before becoming active. Recent edits remain searchable before batched index maintenance. Measurements and limits are in [ANN validation](docs/ANN-VALIDATION.md).

**Pause** stops new remote calls and rejects late results. **Resume** reconciles the previously approved scope. Saving semantic settings or changing local exclusions pauses remote work. Scope reductions take effect immediately; expanding scope requires a new build. Changes to endpoint, model, requested dimensions, or passage length require a connection test and build. Rotating a key does not change the vector space. To handle a provider changing a model under the same ID, run a manual build.

Building again regenerates all selected passages into a new local generation and switches when complete. Interrupted builds preserve the previous generation. A missing or incompatible semantic cache requires a manual build; it never silently sends the entire vault again. Rebuilding the keyword index pauses remote work; review its status before resuming.

Network and rate-limit failures receive at most two retries. Authentication, response-contract, dimension errors, and exhausted retries pause remote work; keyword search remains usable. A request that times out or is cancelled locally may still finish remotely. It retains its concurrency slot until it settles, and its late result is ignored.

## Development

```sh
npm ci
npm install -g @lancedb/lancedb@latest
npm run check:runtime
npm run package:darwin-arm64
npm run verify:m0
npm run verify:m1
npm run verify:m2
npm run verify:m3
npm run verify:ann
npm run lint
```

`npm run dev` watches both entry points. `package:darwin-arm64` builds the current macOS arm64 prototype ZIP under `dist/`; native dependencies are excluded. The build-only SDK type dependency is `latest`. The development lockfile records an install snapshot, and `npm update @lancedb/lancedb` refreshes it; it does not pin the separately installed global runtime package.

The runtime checks, verification scripts, and benchmark accept optional Node and global module paths:

```sh
npm run check:runtime -- /absolute/path/to/node /absolute/path/to/global/node_modules
npm run verify:m0 -- /absolute/path/to/node /absolute/path/to/global/node_modules
npm run verify:m1 -- /absolute/path/to/node /absolute/path/to/global/node_modules
npm run verify:m2 -- /absolute/path/to/node /absolute/path/to/global/node_modules
npm run verify:m3 -- /absolute/path/to/node /absolute/path/to/global/node_modules
npm run verify:ann -- /absolute/path/to/node /absolute/path/to/global/node_modules
```

The verification extracts the ZIP to a directory containing Chinese characters and spaces, clears the child's PATH, and tests the explicit global installation. M0 checks integrity and native compatibility. M1 checks query semantics and incremental races. M2 adds kernel locking, process death, generation switching, interrupted rebuilding, incompatible caches, a large Unicode note, and Git/rsync exclusions using a custom configuration directory. `npm run benchmark:keywords` generates 10,000 synthetic documents (about 102 MiB), measures candidate search plus 50 snippets, and removes its temporary data. It is a scale check, not a relevance evaluation or an Obsidian UI benchmark. No build artifacts are committed.

M3 uses synthetic notes, a controlled embedding transport, and the real global LanceDB to check opt-in, response validation, incremental reuse, scope and model isolation, cancellation, recovery, and persisted vector search. Real Obsidian HTTP/SecretStorage/UI checks used a local fixture server. A commercial provider and semantic relevance have not been measured; configure your own provider and use the connection test.

`verify:ann` checks the real global SDK's ANN plans, small datasets, legacy-vector migration, filtering and long-note refill, incremental visibility, growth, and failed-build isolation. `npm run benchmark:vectors` creates 10,000 synthetic notes with 30,000 384-dimensional vectors, verifies that ordinary searches probe a subset of partitions, and measures latency and note recall against exhaustive cosine search. It also checks probe expansion for a narrow filter and deletes its temporary data. This benchmark excludes remote embedding, IPC, and Obsidian UI time.

## Cache, sync, and upgrades

The M0 check uses temporary sample databases below `.obsidian/plugins/lancedb-search/cache/m0/`. Keyword search persists note text and metadata under `cache/keyword-<device>/generations/<generation>/`; semantic vectors, passage snippets, and local metadata live under `cache/keyword-<device>/semantic/<generation>/`. The random device ID is stored in Obsidian's local vault storage, separate from plugin `data.json` and vault synchronization. Copying a full Obsidian profile also copies that identity; separate profiles have separate caches. M1 hostname-based caches are no longer selected and can be removed with Obsidian closed.

macOS holds an exclusive kernel lock on `writer.lock`, which is released automatically on normal shutdown or process death. The file remains on disk and is not evidence of an active writer. Never delete it to bypass an occupied-cache error; close the other window and reload the plugin. `current.json` records the compatible cache format and active generation, and is replaced atomically after a rebuild. Unknown formats or incomplete schemas prompt an explicit local rebuild. Previous/abandoned generations are cleaned on the next successful start or before another rebuild; settings and Markdown are untouched.

The entire `cache/` folder is disposable with Obsidian closed; preserve `data.json`. Deleted or excluded text can remain in old database versions until the cache is removed; exclusions are not a secure-erasure feature. Index maintenance considers accumulated changes, text volume, and time since maintenance; it does not rebuild FTS on every save.

If you use a sync tool, exclude LanceDB database files. A directory name does not prevent synchronization. Single-device use does not require a second device or a Sync acceptance test:

- Git: add `.obsidian/plugins/lancedb-search/cache/` to the vault's `.gitignore`; verify with `git check-ignore -v .obsidian/plugins/lancedb-search/cache/probe`. Already tracked files require separate removal from Git's index.
- Obsidian Sync: disable **Installed community plugins** in **Settings → Sync → Vault configuration sync** for this manual installation, and install the plugin and global dependency separately per device. This Sync behavior has not yet been verified here; when adding another device, check that a disposable cache marker is not transferred.
- Other sync tools: explicitly exclude `.obsidian/plugins/lancedb-search/cache/**` and verify it with a disposable marker. If exclusion is unavailable, use an unsynchronized test vault.

Replace plugin files and update global npm dependencies only with Obsidian closed. Preserve `data.json` when replacing the plugin. For a rollback, restore the previous complete plugin package and rebuild or remove its cache if its format is incompatible. Cache generations are an implementation detail, not a database compatibility promise across plugin or SDK versions. Remote embedding rebuilds must be user initiated. The manual CI workflow produces an installation artifact without publishing a release.

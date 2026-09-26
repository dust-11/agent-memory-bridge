# AI Agent Memory Bridge

A lightweight, tiered persistent memory system for AI agents. Three-layer architecture with semantic routing, cross-agent sharing, and full privacy control.

Built for—and battle-tested in—the [Hermes Agent](https://github.com/NousResearch/hermes-agent) and OpenClaw ecosystems.

## Architecture

```
┌─────────────────────────────────────────────┐
│               bridge.js (CLI)                │
│  node bridge.js write/search/query/delete…   │
├─────────────────────────────────────────────┤
│  lib/                                        │
│  ├── db.js           SQLite connection       │
│  ├── classifier.js   Type + depth detection  │
│  ├── memory.js       Write pipeline          │
│  ├── search.js       Search & query engine   │
│  ├── archive.js      Cold data archiving     │
│  └── delete.js       Deletion + recycle bin  │
└─────────────────────────────────────────────┘
```

## Three Memory Tiers

| Tier | Persistence | Retrieval | Use Case |
|------|-------------|-----------|----------|
| **Conversation history** | Compressed per session | Full-text search | Recent context |
| **Deep memory** | Permanent | Semantic search (top-K injection) | Important facts, user profile |
| **Shallow memory** | Permanent | Search-engine index only | Secondary details |

## Features

- **🔄 Cross-agent shared memory** – Multiple agents (Hermes, OpenClaw, etc.) read and write the same store
- **🔍 Smart routing** – Short queries → shallow memory; long queries → deep memory with semantic scoring
- **🏷️ Auto-classification** – New memories are automatically classified by type (core/emotion) and depth (deep/shallow)
- **⚓ Anchor system** – Related memories are grouped under semantic anchors; conflict detection on write
- **⭐ Weighted scoring** – Search results ranked by `semantic_similarity × weight`, combining relevance with priority. Cold-start resistant (weight-dominant) with graceful transition to hybrid sorting
- **📊 Memory stats** – Built-in diagnostics (`memory-stats`) show anchor counts, weight distribution, and decay activity
- **🎯 Anchor activity tracking** – Search hits automatically update anchor `last_active_at`, enabling inactivity-based decay and dormant detection
- **🧊 Archive mechanism** – Cold data is automatically archived, searchable, and restorable
- **🗑️ Recycle bin** – Deleted memories go to a recycle bin with restore capability
- **🔒 Fully local** – No external services, no vector database, no data leaves your machine

## Quick Start

```bash
# Install dependencies (declared in package.json)
npm install

# Write a memory
node bridge.js write '{"content":"User prefers concise CLI outputs","source":"agent","type":"core"}'

# Search memories
node bridge.js search '{"query":"CLI outputs","limit":5}'

# Query by type/depth
node bridge.js query '{"type":"core","depth":"deep","limit":10}'

# List all anchors (summary view)
node bridge.js summary

# Archive old anchors
node bridge.js auto-archive
```

## CLI Reference

```
write <json>     Write a new memory
search <json>    Semantic search across all memory
search-deep      Deep-level search with minScore filter
query <json>     Query by type, depth, keyword
anchors          List all memory anchors
summary          Summarized view of recent memories
get <id>         Get a specific memory by ID
delete <id>      Delete a memory (moves to recycle)
batch-delete     Batch delete (by type, depth, query)
recycle          List recycle bin
restore <id>     Restore from recycle
expire           Expire outdated shallow memories
archive <id>     Archive an anchor
unarchive <id>   Restore from archive
auto-archive     Auto-archive based on age/size
archive-list     List archived anchors
archive-stats    Archive statistics
archive-search   Search within archives
memory-stats     System diagnostics (anchors, weights, decay)
```

## `write` Input Format

```json
{
  "content": "Memory content text",
  "source": "agent_name",
  "type": "core|emotion",
  "depth": "deep|shallow",
  "keywords": ["keyword1", "keyword2"],
  "options": {
    "forceDepth": "shallow"
  }
}
```

- If `depth` is omitted, it defaults to `shallow`
- If `type` is omitted, the classifier auto-detects it
- Conflict detection runs automatically on write; flagged anchors are returned in response but not blocked

## Requirements

- **Node.js 18+**
- No external databases, no vector stores, no cloud services

The SQLite database (`memory.db`) is **created automatically on first run** — schema, tables and indexes are initialized by `lib/db.js`. You do not need to create it by hand.

## Dependencies

All runtime dependencies are declared in `package.json`:

| Package | Purpose | License | Install |
|---------|---------|---------|---------|
| [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | SQLite driver (synchronous, WAL mode) | MIT | `npm install` |
| [`nodejieba`](https://github.com/yanyiwu/nodejieba) | Chinese word segmentation (used by `lib/search.js`) | MIT | `npm install` |
| [`uuid`](https://github.com/uuidjs/uuid) | Memory ID generation | MIT | `npm install` |

> `nodejieba` ships a native addon. On Linux/macOS it compiles or downloads a prebuilt binary automatically; on Windows you may need build tools. If you only use English content, you can replace the tokenizer in `lib/search.js`.

## What Is NOT Included

This repository contains **only the core memory engine** — storage, classification, anchors, archiving and the recycle bin. The following are **pluggable external capabilities** and are deliberately not bundled:

- **Vector / semantic search (e.g. zvec)** — the upstream deployment uses an external vector index. This repo ships a TF-IDF / keyword fallback inside `lib/search.js`. Bring your own embedding backend if you need true semantic recall.
- **BM25 full-text ranking** — not bundled; `lib/search.js` implements a lighter keyword-scoring path.
- **Anchor classification via LLM** — assigning memories to semantic anchors through a large language model requires **your own API key and prompt**. No prompt, key, endpoint or model configuration is included here.
- **No API keys, no credentials, no private data** — nothing of that kind is shipped in this repository.

`lib/search.js` is written so these can be swapped in later — search is intentionally the most modular layer.

## Credits & Third-Party Works

This project stands on the shoulders of the following open-source works:

- [**better-sqlite3**](https://github.com/WiseLibs/better-sqlite3) by WiseLibs — MIT
- [**nodejieba**](https://github.com/yanyiwu/nodejieba) by Yanyiwu — MIT
- [**uuid**](https://github.com/uuidjs/uuid) by the uuid.js authors — MIT
- Chinese segmentation dictionary conventions follow the [jieba](https://github.com/fxsjy/jieba) project — MIT

No third-party source code is vendored into this repository; all of the above are consumed as regular npm dependencies and remain under their own licenses.

## License

Apache 2.0 — see [`LICENSE`](LICENSE).

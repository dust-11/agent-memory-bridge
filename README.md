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
- **🧊 Archive mechanism** – Cold data is automatically archived, searchable, and restorable
- **🗑️ Recycle bin** – Deleted memories go to a recycle bin with restore capability
- **🔒 Fully local** – No external services, no vector database, no data leaves your machine

## Quick Start

```bash
# Install dependencies
npm install better-sqlite3

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
archive-search   Search within archives
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

## Environment

- Node.js 18+
- SQLite via `better-sqlite3`
- No external databases, no vector stores, no cloud services

## License

Apache 2.0

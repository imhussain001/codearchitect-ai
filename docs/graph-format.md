# Graph format (`codearchitect/v1`)

Graphs move between the app, the API and disk as JSON. **Export → Code base** writes a ZIP containing every component's code at its `filePath`, plus this manifest as `codearchitect.graph.json`. Uploading that ZIP, or the JSON on its own, restores the graph exactly.

The schema is `GraphSchema` in `lib/graphSchema.ts`; the browser and the API validate against the same definition.

## Envelope

```jsonc
{
  "format": "codearchitect/v1",
  "exportedAt": "2026-10-16T11:00:00.000Z",
  "graph": { /* ArchitectureGraph */ }
}
```

A bare `ArchitectureGraph`, without the envelope, is also accepted.

## `ArchitectureGraph`

```jsonc
{
  "id": "auth-microservice",          // unique; drives canvas remounts
  "name": "Auth Microservice",
  "description": "…",
  "nodes": [ /* ArchNode */ ],
  "edges": [ /* DependencyEdge */ ],
  "commits": [ /* CommitSnapshot, oldest first */ ],
  "scenarios": [ /* ImpactScenario */ ],
  "rules": [ /* architecture rules, see cli-and-ci.md */ ],
  "kindLabels": { "data": "Data files" },   // optional: rename the four layers for this graph
  "warnings": ["optional notes shown on load"]
}
```

### Node

```jsonc
{
  "id": "users-db",
  "type": "component",                // always "component"
  "position": { "x": 480, "y": 520 },
  "data": {
    "label": "Users Database",
    "kind": "data",                   // frontend | api | logic | data
    "filePath": "src/server/db/users.ts",
    "description": "PostgreSQL users table and repository.",
    "language": "ts",
    "code": "import { Pool } from \"pg\";\n…",   // ≤ 60,000 chars
    "exports": ["usersRepo", "UserRow"],
    "imports": ["pg", "bcrypt"],
    "params": [{ "name": "userId", "type": "number", "description": "optional" }],
    "keywords": ["database", "users", "schema"], // feed the prompt→node ranking
    "isDraft": false,                 // optional; true = drawn in the builder
    "lineCount": 412                  // optional; real file size when `code` is truncated
  }
}
```

`keywords` matter most for the local impact engine: a keyword hit is worth 3 points (see [engines.md](engines.md#2-root-ranking-no-scenario)). Include the words people will use when describing changes to this component.

### Edge

```jsonc
{ "id": "e-ctrl-db", "source": "auth-controller", "target": "users-db",
  "relation": "reads",                // calls | reads | writes | imports | publishes
  "label": "findById()", "isDraft": false,
  "typeOnly": false,
  "symbols": ["verifyToken"] }          // optional; names the source uses from the target ("*" = whole module). Absent = unknown                 // optional; true = only an `import type` (ignored by health, kept by rules and blast radius)
```

**Direction:** `source` depends on `target`.

### Commit (time-machine frame)

```jsonc
{
  "hash": "9c02e5a", "author": "dev.okafor", "date": "2026-05-07",
  "message": "perf(auth): Redis revocation list",
  "phase": "Phase 3 · Redis cache",
  "narrative": "Why this structural change happened…",
  "addedNodeIds": ["session-cache"],   // first appearance on the canvas
  "modifiedNodeIds": ["jwt-service"]
}
```

A node that no commit adds is treated as older than the history and is always visible.

### Impact scenario

Scenarios give the local engine exact answers for well-known changes.

```jsonc
{
  "id": "auth-userid-uuid",
  "title": "Migrate userId from integer to UUID v4",
  "triggers": ["uuid", "user_?id.*(string|uuid)"],  // case-insensitive regex sources
  "rootNodeId": "users-db",
  "summary": "…",
  "extraImpacts": [{ "nodeId": "jwt-service", "reason": "sub claim typed number" }],
  "diffs": [{ "nodeId": "users-db", "after": "<complete new file>", "rationale": "…" }]
}
```

Nodes with an entry in `diffs` are reported as **broken**. Other reachable dependents are reported as **review only**.

## Limits

| Field | Limit |
|---|---|
| `nodes` / `edges` | 200 / 1,000 |
| `data.code`, scenario `after` | 60,000 chars |
| strings such as `label` and `filePath` | 500 chars |
| `exports` / `imports` / `params` / `keywords` | 100 / 200 / 50 / 50 items |
| `commits` / `scenarios` | 500 / 50 |

## Generating graphs programmatically

`scripts/build-self-graph.mjs` is a worked example. It hand-authors the component list, derives edges from real `import` statements, builds scenario diffs by applying exact string edits to the real files (it fails if an edit no longer applies), and reads Story frames from `git log --name-status`. Run it with `npm run graph:self`.

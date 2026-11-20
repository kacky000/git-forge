# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kacky000/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kacky000/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process with no dependencies: it speaks git smart HTTP
(clone, fetch, shallow fetch and push, with its own packfile reader and writer), the REST v3 API
under `/api/v3`, the GraphQL v4 API at `/api/graphql` and a Model Context Protocol endpoint at
`/mcp`, all over one in-memory store. There is no git binary, no database and no UI: only the Node
standard library.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=secret FORGE_PORT=8787 node --experimental-strip-types main.ts
```

Node 22.18 or later runs the TypeScript sources directly (the flag is only needed on older 22.x).
Every request except `GET /healthz` needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. With
`MAKEFUN_ENV_URL` set, the process instead binds an ephemeral port, registers it with the suite at
that URL and exits when the suite reports it is done.

```sh
# create a repository, then use it with an ordinary git client
curl -H "Authorization: Bearer secret" -d '{"name":"demo","auto_init":true}' http://127.0.0.1:8787/api/v3/user/repos
git -c http.extraHeader="Authorization: Bearer secret" clone http://127.0.0.1:8787/adaiversen/demo.git
```

## What it serves

| Surface | Path | Notes |
| --- | --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git` | upload-pack protocol v2 (`ls-refs`, `fetch`, shallow and deepen) with a v0 fallback; receive-pack v0 with `report-status`, `side-band-64k`, `delete-refs`; fast-forward-only updates, judged per ref |
| REST v3 | `/api/v3` | repositories, branches, refs, commits, contents, labels, issues, comments, pull requests, files and merges; `Link` pagination; JSON errors |
| GraphQL v4 | `/api/graphql` | the documents `gh` and `github-mcp-server` send: viewer, repository, issues, pull requests, `node(id:)`, cursor paging, introspection, the create/close/merge/comment mutations, batching |
| MCP | `/mcp` | JSON-RPC 2.0 over Streamable HTTP, for 2026-07-28 (`server/discover`) and the earlier handshake revisions; 24 tools over the same store |

## Layout

- `main.ts`: process lifecycle (bind, register, wait, exit).
- `app.ts`: the front door: authentication and routing to a surface.
- `src/http/`: a small HTTP/1.1 server on `node:net` that frames requests and writes each reply in one socket write.
- `src/git/`: the object database, packfiles, pkt-lines, commit-graph walks, tree editing and merging, and the smart HTTP services.
- `src/core/`: the store and the services every surface shares (repositories, contents, issues, pull requests).
- `src/rest/`, `src/graphql/`, `src/mcp/`: the three API surfaces over those services.
- `test/selftest.ts`: an end-to-end check that drives a live instance over HTTP.

## Design notes

- Objects are content addressed and never deleted, so one object map serves every repository and a
  repository is only its refs. A pushed pack's compressed entries are kept as they arrived, so a
  later fetch reuses them instead of compressing again, and a clone's whole reply is cached by what
  it asked for.
- Handlers are synchronous functions from a request to a reply: one request can never observe
  another's half-finished update.
- Timestamps come from a logical clock that starts at `MAKEFUN_TRIAL_NOW`, so the same requests
  produce the same commit ids on every run.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9ykrm1qx&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

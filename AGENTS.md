# Repository agent instructions

Use `CLAUDE.md` as the repository-specific development guide.

## Cross-service Graphify

The authoritative Alitycs knowledge graph spans the sibling services in the parent workspace. Set
`ALITYCS_WORKSPACE_ROOT` when that workspace is not mounted at `/Volumes/External/alitycs`.

- Default workspace: `${ALITYCS_WORKSPACE_ROOT:-/Volumes/External/alitycs}`
- Graph: `${ALITYCS_WORKSPACE_ROOT:-/Volumes/External/alitycs}/graphify-out/graph.json`
- Global Graphify tag: `alitycs`
- Initialize the shell variable once with `export ALITYCS_WORKSPACE_ROOT="${ALITYCS_WORKSPACE_ROOT:-/Volumes/External/alitycs}"`.
- Use the parent graph for repo-local and cross-service questions; do not create or prefer a repo-local graph.
- Start with `graphify query "<question>" --graph "$ALITYCS_WORKSPACE_ROOT/graphify-out/graph.json"`. Use `graphify path` or `graphify explain` with the same `--graph` argument for focused relationships.
- After code changes, run `graphify update "$ALITYCS_WORKSPACE_ROOT"`, then `graphify global add "$ALITYCS_WORKSPACE_ROOT/graphify-out/graph.json" --as alitycs`.
- After documentation or service-boundary changes, run `graphify extract "$ALITYCS_WORKSPACE_ROOT" --backend openai-luna-none`, `graphify cluster-only "$ALITYCS_WORKSPACE_ROOT" --backend=openai-luna-none --no-viz`, then refresh the global tag.
- In a standalone clone without the parent graph, skip the cross-service Graphify steps.
- Do not install per-repo Graphify Git hooks; the parent workspace contains multiple independent repositories.

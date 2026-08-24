# Repository agent instructions

Use `CLAUDE.md` as the repository-specific development guide.

## Cross-service Graphify

The authoritative Alitycs knowledge graph spans the sibling services under `/Volumes/External/alitycs`.

- Graph: `/Volumes/External/alitycs/graphify-out/graph.json`
- Global Graphify tag: `alitycs`
- Use the parent graph for repo-local and cross-service questions; do not create or prefer a repo-local graph.
- Start with `graphify query "<question>" --graph /Volumes/External/alitycs/graphify-out/graph.json`. Use `graphify path` or `graphify explain` with the same `--graph` argument for focused relationships.
- After code changes, run `graphify update /Volumes/External/alitycs`, then `graphify global add /Volumes/External/alitycs/graphify-out/graph.json --as alitycs`.
- After documentation or service-boundary changes, run `graphify extract /Volumes/External/alitycs --backend openai-luna-none`, `graphify cluster-only /Volumes/External/alitycs --backend=openai-luna-none --no-viz`, then refresh the global tag.
- Do not install per-repo Graphify Git hooks; the parent workspace contains multiple independent repositories.

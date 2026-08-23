# Contributing

Thank you for improving the Alitycs JavaScript SDKs. Contributions should preserve the public API,
wire compatibility, runtime safety, and small browser footprint.

## Before opening a pull request

- Use a GitHub issue for bugs or proposals that change public behavior.
- Use [private vulnerability reporting](SECURITY.md) for security-sensitive findings.
- Keep changes focused. Do not add undocumented analytics products or send browser events to the
  tenant-scoped `/v1/*` read API.
- Add or update tests for every behavior change.

## Local setup

Install Bun `1.3.14` and Python 3, then run:

```bash
bun install --frozen-lockfile
bun run typecheck:all
bun run lint:all
bun run format:check
bun run test:all
bun run build:all
./scripts/validate-coderabbit.sh
```

The coverage gate is 90% lines and 85% functions for every package. Tests must remain deterministic
and must not require live Alitycs credentials.

## Wire-contract changes

The canonical batch and event contract is [`specs/event-schema.json`](specs/event-schema.json).
Changing it requires coordinated worker and downstream compatibility work. Ordinary SDK features
should not change the schema.

The ingestion contract is:

- `POST https://api.alitycs.com/events`
- `Authorization: Bearer <apiKey>`
- `Content-Type: application/json`

Never commit credentials, customer data, generated `dist/` output, or local environment files.

## Pull requests

Describe the user-visible effect, compatibility impact, and commands you ran. Maintainers may ask
for a changeset in `CHANGELOG.md` when a change affects consumers. By contributing, you agree that
your contribution is licensed under this repository's MIT License. Configure GitHub-verified commit
signing before pushing; commits merged into `main` must carry verified signatures.

CodeRabbit automatically reviews ready, human-authored pull requests and may request changes for
correctness, security, compatibility, or test gaps. The required `Alitycs CodeRabbit Gate` check
verifies that its approval covers the latest pushed commit; pushing another commit triggers an
incremental review. The complete standalone policy and trusted evaluator live in this repository;
see [CodeRabbit review gate](docs/coderabbit.md) for operation and upgrade procedures.
Dependabot, Renovate, and GitHub Actions bot pull requests are intentionally skipped and instead
require the normal CI checks plus one current-head human maintainer approval. If an approval lands
after the evaluator times out, comment `/coderabbit-gate` to reconcile it. Administrators should
use the documented protection override only as an incident break-glass measure and restore and
verify the branch policy immediately afterward.

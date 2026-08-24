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

Install Bun `1.3.14`, Bash, Git, jq, CPython 3.11 through 3.14, and Ruby 3.3 or newer,
then run:

```bash
bun install --frozen-lockfile
bun run typecheck:all
bun run lint:all
bun run format:check
bun run test:all
bun run build:all
./scripts/verify-workflow-pins.rb
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
signing if desired; commit signatures are optional and are not part of the required branch baseline.

CodeRabbit automatically reviews every ready pull request, including dependency updates, and may
request changes for correctness, security, compatibility, or test gaps. It re-reviews each new
commit and approves only after its blocking findings are resolved, the latest commit is reviewed,
and configured pre-merge checks pass. GitHub requires CodeRabbit's native status together with the
repository's deterministic CI checks. Changes to CodeRabbit policy, CODEOWNERS, validation scripts,
or GitHub workflows also require owner review. See the repository-owned
[CodeRabbit review policy](docs/coderabbit.md) for operation and rollout details.

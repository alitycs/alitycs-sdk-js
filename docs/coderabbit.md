# CodeRabbit review policy

This repository owns its complete CodeRabbit policy in [`.coderabbit.yaml`](../.coderabbit.yaml).
It does not inherit from a central policy repository and does not use a separate GitHub App,
private key, environment, or reconciliation workflow.

## Merge contract

CodeRabbit reviews every ready pull request, including dependency updates. Automatic incremental
review is enabled, so every push is evaluated again. Draft pull requests wait until they are marked
ready.

`reviews.request_changes_workflow: true` makes CodeRabbit submit a GitHub `CHANGES_REQUESTED`
review when blocking findings remain and an `APPROVED` review after those findings are resolved,
the latest commit is reviewed, and configured pre-merge checks pass. The native `CodeRabbit`
status reports whether the review completed; it is paired with the formal review state because a
successful completion status alone is not an approval. `reviews.fail_commit_status: true` makes a
review error fail CodeRabbit's outward status instead of appearing successful.

The protected `main` branch requires:

- the native `CodeRabbit` status from the `coderabbitai` GitHub App (App ID `347564`);
- the repository-owned `Verify` and `Review` CI checks;
- one current approval, stale-review dismissal, and approval after the latest push;
- resolved review conversations and the configured CODEOWNER for governance-file changes; and
- linear history, with force pushes and branch deletion disabled.

Commit signatures are optional. CodeRabbit configuration and enforcement stay inside this
repository, but no custom Alitycs gate identity is provisioned.

## Repository-owned validation

The committed schema snapshot and hash-locked validator dependencies make configuration validation
deterministic:

```bash
./scripts/validate-coderabbit.sh
```

CI runs this validation whenever `.coderabbit.yaml` or its validator inputs change. The scheduled
`.github/workflows/coderabbit-schema-drift.yml` workflow compares the snapshot with CodeRabbit's
live schema. It is deliberately not a required merge check because upstream schema availability or
drift must not make unrelated pull requests unmergeable.

All GitHub Actions and reusable workflows must use immutable commit SHAs. Docker actions and
workflow container or service images must use immutable SHA-256 digests. Jobs must use an explicit,
versioned GitHub-hosted runner matching
`(ubuntu-<NN.NN>|windows-<N>|macos-<N>)(-lowercase-segment)*`; do not use a moving `*-latest` label.
YAML merge keys (`<<`) are rejected because GitHub Actions does not support them and they can hide
references from structural validation.

Run the complete local governance checks with:

```bash
./scripts/verify-workflow-pins.rb
./scripts/validate-coderabbit.sh
bun run test:policy
```

## Owner protection

[`.github/CODEOWNERS`](../.github/CODEOWNERS) assigns the repository owner to `.coderabbit.yaml`,
the complete `.github/` tree, the pinned validator inputs, the workflow-pin verifier, this guide,
and the contribution policy. Branch protection requires a CODEOWNER review when any of those files
change. This prevents an ordinary pull request from weakening CodeRabbit or CI policy while still
keeping the policy visible and independently versioned in each SDK repository.

## Operations

For a normal pull request:

1. Wait for the native `CodeRabbit` status and repository CI checks on the latest commit.
2. Resolve blocking review threads or push a fix.
3. Confirm CodeRabbit's latest formal review is `APPROVED` before merging.

If a review event is missed, ask CodeRabbit for a full review in the pull request. Do not create a
replacement status with Actions and do not add repository secrets for review reconciliation. During
a confirmed CodeRabbit outage, an owner may temporarily remove only the native CodeRabbit required
status, merge urgent work with the remaining review and CI protections, then restore the status and
verify it with a canary pull request. Record that exception in the affected pull request.

## Adding a future SDK

Each future public `alitycs-sdk-*` repository should independently:

1. Install the official `coderabbitai` GitHub App for that repository.
2. Commit a repository-specific `.coderabbit.yaml`, this operational guide, CODEOWNERS, pinned
   schema validation, and ordinary language-specific CI/CD workflows.
3. Keep automatic and incremental review, request-changes behavior, and fail-closed review errors
   enabled. Do not exclude dependency bots when the native status is required.
4. Open a canary pull request and confirm the native status and formal review both target its latest
   commit.
5. Require the native `CodeRabbit` status from App ID `347564`, the repository's deterministic CI
   checks, current approval, conversation resolution, and CODEOWNER review for governance files.

No central public CodeRabbit policy repository or custom Alitycs Gate App is part of this baseline.

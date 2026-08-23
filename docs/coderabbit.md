# CodeRabbit review gate

This repository owns its complete CodeRabbit policy in `.coderabbit.yaml`; it does not inherit
configuration from another repository. Keep the policy, trusted gate workflow, contributor docs,
and branch protection in sync when review behavior changes.

## Merge policy

- Ready, human-authored pull requests are reviewed automatically. The required
  `Alitycs CodeRabbit Gate` check passes only when CodeRabbit's latest state-changing review is an
  approval of the exact current head commit.
- Dependabot, Renovate, and GitHub Actions bot pull requests are intentionally skipped by
  CodeRabbit. Their gate passes only after a non-bot maintainer with write access approves the
  exact current head commit.
- Comment-only reviews never erase an approval. A later changes-requested or dismissed review does
  on the next reconciliation; after manually dismissing a review, run `/coderabbit-gate` before
  merging.
- CodeRabbit rate-limit and no-review outcomes fail closed even if CodeRabbit's own informational
  status reports success.
- If approval arrives after the evaluator times out, a maintainer can comment
  `/coderabbit-gate` or dispatch the `CodeRabbit gate` workflow with the pull-request number.
- If CodeRabbit reports that no review was needed but does not submit a formal exact-head approval,
  request one with `@coderabbitai full review`; the gate intentionally remains blocked until then.

Do not add review path exclusions. An excluded-only human commit cannot receive the exact-head
formal review required by the gate, and lockfiles and generated artifacts can be supply-chain
sensitive.

## Trust boundary

`.github/workflows/coderabbit-gate.yml` runs with `pull_request_target` from trusted `main`, never
checks out or executes pull-request code, and writes the head check with the dedicated
`Alitycs CodeRabbit Gate` GitHub App. Its app key is an environment secret in `coderabbit-gate`;
that environment must allow deployments only from `main`.

The gate rejects any ordinary pull request that adds, removes, renames, or changes its own workflow
file. This prevents a pull request from replacing the evaluator while retaining the required check
name. Branch protection must bind `Alitycs CodeRabbit Gate` to the dedicated app ID, and bind
`Verify` and `Review` to the GitHub Actions app.

## Seed a future SDK

1. Create a public `alitycs/alitycs-sdk-<name>` repository with `main` as its default branch and
   install CodeRabbit plus `Alitycs CodeRabbit Gate` for all organization repositories.
2. Add a complete, standalone `.coderabbit.yaml`, the trusted gate workflow, CI, dependency review,
   release automation, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and a pull-request template.
3. Create the `coderabbit-gate` environment with a selected deployment-branch policy for `main`
   only. Set repository variable `ALITYCS_CODERABBIT_GATE_CLIENT_ID` and environment secret
   `ALITYCS_CODERABBIT_GATE_PRIVATE_KEY`.
4. Merge those baseline files using the repository's existing protections. The gate cannot be
   required before its trusted workflow exists on `main`.
5. Open a separate human-authored canary pull request. Verify successful `Verify`, `Review`, and
   `Alitycs CodeRabbit Gate` checks on the exact head plus a formal CodeRabbit approval.
6. Require those three checks with strict branch updates. Enforce protection for administrators,
   signed commits, linear history, resolved conversations, stale-review dismissal, and last-push
   approval; disallow force-pushes and deletion. Keep the native approval count at zero because
   GitHub does not count GitHub App approvals as write-access reviewer approvals.
7. Exercise the ignored-bot path: confirm the gate blocks a bot update, approve its exact head as a
   maintainer, reconcile the gate, then dismiss the test approval so the pull request is blocked
   again.

## Upgrade the gate

Gate workflow updates use a recorded two-phase break-glass procedure. Open and fully review the
change, temporarily remove only the dedicated gate check from branch protection, merge after every
other required check passes, and immediately open a canary against the new trusted workflow. Restore
the app-bound required check only after the canary succeeds. Never disable the surrounding CI,
signature, history, conversation, force-push, or deletion protections.

For app-key rotation, add a new GitHub App private key, update the environment secret in every SDK,
run a canary in each repository, and only then revoke the old key.

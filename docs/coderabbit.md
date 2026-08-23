# CodeRabbit review gate

This repository owns its complete CodeRabbit policy in `.coderabbit.yaml`; it does not inherit
configuration from another repository. Keep the policy, trusted gate workflow, contributor docs,
and branch protection in sync when review behavior changes.

Policy validation is also repository-owned: `scripts/coderabbit-schema.v2.json` is the reviewed
schema snapshot, and `scripts/coderabbit-validator-requirements.txt` locks the validator and every
transitive Python dependency by hash. `scripts/validate-coderabbit.sh` verifies the schema digest,
creates an isolated environment with Python 3.11 or newer, and never uses an ambient validator
from `PATH`.

## Merge policy

- Ready, human-authored pull requests are reviewed automatically. The required
  `Alitycs CodeRabbit Gate` check passes only when CodeRabbit's latest state-changing review is an
  approval of the exact current head commit.
- Dependabot, Renovate, and GitHub Actions bot pull requests are intentionally skipped by
  CodeRabbit. Their gate passes only after a non-bot maintainer with write access approves the
  exact current head commit.
- Comment-only reviews never erase an approval. Submitted and dismissed state-changing reviews
  automatically wake the trusted evaluator, so a later changes-requested or dismissed review
  replaces the prior gate result.
- CodeRabbit rate-limit and no-review outcomes fail closed even if CodeRabbit's own informational
  status reports success.
- A maintainer can comment `/coderabbit-gate` or dispatch the `CodeRabbit gate` workflow with
  the pull-request number to recover from a missed GitHub event.
- Pushes to `main` automatically reconcile every open pull request so the newest exact-head gate
  evaluation also reflects the current base branch.
- If CodeRabbit reports that no review was needed but does not submit a formal exact-head approval,
  request one with `@coderabbitai full review`; the gate intentionally remains blocked until then.

Do not add review path exclusions. An excluded-only human commit cannot receive the exact-head
formal review required by the gate, and lockfiles and generated artifacts can be supply-chain
sensitive.

## Trust boundary

`.github/workflows/coderabbit-review-event.yml` is an unprivileged
`pull_request_review` signal. It has no token permissions, checkout, secrets, environment,
artifacts, outputs, concurrency keys, or use of pull-request data. Its completion wakes the
read-only routing job in `.github/workflows/coderabbit-gate.yml` through `workflow_run`; the router
validates the canonical signal workflow ID, name, and path before allowing the secret-bearing job
to start. It accepts review-signal actors only when they are CodeRabbit or currently have write,
maintain, or admin repository permission; comment-only outsider reviews cannot start the
secret-bearing evaluator. Ordinary title or body edits are also ignored, while a base-branch edit
is reconciled. If GitHub omits the linked pull-request array for a fork, the router resolves open
`main` pull requests by exact source-head or synthetic merge-commit SHA and requires exactly one
match. The downstream evaluator fetches every routed pull request and all reviews fresh from
GitHub. The signal's conclusion and payload are never authorization.

GitHub does not support branch filters on `pull_request_review`. The signal is therefore
intentionally branch-agnostic and remains unprivileged; the trusted evaluator skips any pull
request whose fresh base ref is not `main` before publishing a gate check.

The trusted gate also runs with `pull_request_target` from `main`, never checks out or executes
pull-request code, verifies approval against the exact head SHA, and writes the required check to
that same head SHA with the dedicated `Alitycs CodeRabbit Gate` GitHub App. This matches the SHA
used by this repository's required `Verify` and `Review` Actions checks. Its app key is an
environment secret in `coderabbit-gate`; that environment must use custom deployment-branch
policies with exactly one `main` branch rule. The App has only Actions read, Checks write,
Contents read, Pull requests read, and implicit Metadata read permissions, with webhooks disabled
and no subscribed events.
Its organization installation uses selected repositories and is limited to public Alitycs SDKs;
never broaden the Gate App to every organization repository. The workflow mints one owner-scoped,
Contents-read token and authenticates a separate Octokit client with it only to enumerate the
complete selected-repository installation, then mints a separate write token scoped to the current
repository for gate evaluation. The evaluator requires the current repository to be selected,
rejects every selected repository that is not an active, public, independent `alitycs-sdk-*`
repository on `main`, and verifies that membership again before reading reviews and immediately
before a gate conclusion. The raw private key can mint tokens for any selected repository, so this
live boundary check and the main-only environment are part of the authorization model.

The organization-wide CodeRabbit App installation is also an exact audited allowlist. Its
permissions are Actions read, Checks write, Contents write, Discussions read, Issues write,
Members read, Metadata read, Pull requests write, and Commit statuses write. Its webhook events
are `issue_comment`, `issues`, `label`, `organization`, `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `pull_request_review_thread`, `release`, and `repository`. Any
permission or event drift fails the post-bootstrap audit and requires an explicit policy review.

The gate resolves the current `main` ref directly, then compares the exact blob identity and file
type of `.coderabbit.yaml` plus the exact Git tree identity of the entire `.github/workflows`
directory with the pull-request head. It rejects an ordinary pull request that adds, removes,
renames, symlinks, or changes the policy or any workflow, and rechecks that `main` did not advance
before publishing a conclusion. Protecting the complete workflow tree prevents another workflow
from satisfying the app-bound `Verify` or `Review` names.
Neither workflow uses an Actions concurrency key because those keys are repository-global and can
be joined by pull-request-controlled workflows. Only the dedicated App emits the stable
`Alitycs CodeRabbit Gate` name; no Actions job or commit status shares it. Each exact head has one
canonical App-owned check. Every reconciliation renames prior canonical checks to unique
`superseded` names with a neutral conclusion, creates a fresh `in_progress` check, claims it with a
run-and-attempt-ranked external ID, re-reads current pull-request and review state, and completes
it. Concurrent older runs yield and supersede their own fresh checks; ownership and uniqueness are
re-read before any conclusion. Branch protection therefore never depends on same-name check
creation order or reopening a completed check. The rollout canary must prove this lifecycle and
that required-check mergeability follows the failure → approval → dismissal → approval sequence.
Bind `Verify` and `Review` only to the GitHub Actions app.

As defense in depth for GitHub's commit-scoped check model, the gate also fails closed when the same
head commit belongs to more than one open pull request targeting `main`. Native branch protection
requires one PR-scoped approval, dismisses stale approvals, and requires approval of the last push;
CodeRabbit supplies that approval for human-authored PRs, while an eligible human maintainer
supplies it for ignored-bot PRs. Close or update a duplicate-head PR, then reconcile the remaining
pull request with `/coderabbit-gate`.

Changing a bot approver's repository permission does not emit a review event. After membership or
role changes, run `/coderabbit-gate` on open ignored-bot pull requests before merging.

## Seed a future SDK

1. Create a public `alitycs/alitycs-sdk-<name>` repository with `main` as its default branch,
   install CodeRabbit, and add that SDK alongside the already enrolled SDKs in the
   selected-repository installation of `Alitycs CodeRabbit Gate`. Do not change the Gate App
   installation to all repositories or select a non-SDK repository. After `alitycs-sdk-`, use
   lowercase alphanumeric name segments separated by single hyphens, such as
   `alitycs-sdk-react-native`; dots, underscores, empty segments, and trailing hyphens are invalid.
2. Add a complete, standalone `.coderabbit.yaml`, both protected gate workflows, their policy
   tests, CI, dependency review, release automation, `README.md`, `CONTRIBUTING.md`,
   `SECURITY.md`, a pull-request template, and `scripts/verify-workflow-pins.rb`. Pin every GitHub
   Action or reusable-workflow `uses:` reference to a full lowercase 40-character commit SHA and
   every `docker://` action to a full lowercase SHA-256 digest. Run
   `./scripts/verify-workflow-pins.rb`, `./scripts/validate-coderabbit.sh`, and the repository policy
   tests before merging the baseline. The structural verifier covers YAML quoting, flow mappings,
   aliases, duplicate keys, and tracked local composite-action metadata. Same-commit actions and
   reusable workflows may use GitHub's `$/` syntax or the compatible `./` syntax; both are resolved
   only to tracked files at the audited commit.
   Copy the pinned schema snapshot, hash-locked validator requirements, and validation script as a
   reviewed set; do not switch validation back to a mutable schema URL or ambient executable.
3. Create the `coderabbit-gate` environment with a selected deployment-branch policy for `main`
   only. Set repository variables `ALITYCS_CODERABBIT_GATE_APP_ID` and
   `ALITYCS_CODERABBIT_GATE_CLIENT_ID`, plus environment secret
   `ALITYCS_CODERABBIT_GATE_PRIVATE_KEY`. Read the environment policy, variables, secret metadata,
   App installation permissions, and remote workflow blobs back through the GitHub API before use.
4. Merge those baseline files using the repository's existing protections. The gate cannot be
   required before its trusted workflow exists on `main`.
5. From a clean checkout of the merged `main`, rerun `./scripts/verify-workflow-pins.rb`,
   `./scripts/validate-coderabbit.sh`, and the repository policy tests, then open a separate
   human-authored canary pull request. Observe an initial gate failure, obtain a formal
   exact-head CodeRabbit approval and successful gate, dismiss it and observe a newer gate failure,
   then obtain a fresh approval and successful gate. Verify there is exactly one stable App-owned
   gate check for the head, that each completed check is renamed and replaced by a fresh
   `in_progress` canonical check, and that `Verify` and `Review` stay bound to the same exact head
   throughout. Repeat with simultaneous manual and review-signal triggers, verify a later
   reconciliation recovers from a deliberately interrupted run, and exercise a real fork pull
   request so fork routing and required-check recognition are observed rather than inferred. Once
   the canary succeeds, set repository variable `ALITYCS_CODERABBIT_GATE_CANARY_SHA` to its full
   lowercase head SHA.
6. Require those three checks with strict branch updates. While the gate is required, repeat the
   dismissal and fresh-approval transitions and verify the pull request becomes unmergeable and
   mergeable respectively. Enforce protection for administrators,
   signed commits, linear history, resolved conversations, stale-review dismissal, and last-push
   approval; disallow force-pushes and deletion. Require one native approval and keep all review
   bypass allowances empty. Confirm the canary reports that CodeRabbit's exact-head approval
   satisfies the human-authored path before closing the bootstrap change.
7. Exercise the ignored-bot path: confirm the gate blocks a bot update, approve its exact head as a
   maintainer, reconcile the gate, then dismiss the test approval so the pull request is blocked
   again.
8. From a clean checkout synchronized to `main`, run
   `./scripts/audit-coderabbit-github.sh alitycs/alitycs-sdk-<name>`. It fails unless the App
   selected-repository mode and permissions, fresh live canary proof of the exact selection,
   environment policy, variables, secret metadata, protected policy blob and workflow tree,
   immutable action references, app-bound required checks, and branch protections match this
   policy. Changing the Gate App, its selected repositories, or an SDK's private-key environment
   secret makes the affected older canary proof stale; rerun a canary and refresh
   `ALITYCS_CODERABBIT_GATE_CANARY_SHA` in every affected SDK. Audit timestamps are read in UTC so
   the comparison is independent of the GitHub CLI client's local timezone, and the canary must
   complete strictly after every relevant update to fail closed on same-second ambiguity. The audit
   directly compares the Gate App selection with every active public SDK in the organization. It
   requires Bash, Git, GitHub CLI authenticated as an organization owner with the `read:user`
   scope, jq, and Ruby 3.3 or newer with its standard-library Psych parser. CI pins Ruby 3.3.12 for
   deterministic workflow parsing.

## Upgrade the gate

Policy or workflow updates use a recorded two-phase break-glass procedure because the entire
workflow tree is protected. Open and fully review changes to `.coderabbit.yaml` or any workflow.
Run `./scripts/verify-workflow-pins.rb` for every workflow change, run
`./scripts/validate-coderabbit.sh` for every policy change and run the repository policy tests
before temporarily removing only the dedicated gate check from branch protection. Merge after
every other required check passes. From a clean checkout of the new `main`, rerun the workflow-pin
verifier, pinned-schema validator, and policy tests before opening a canary against the new trusted
policy and workflow pair. After the canary succeeds, refresh
`ALITYCS_CODERABBIT_GATE_CANARY_SHA` and run
`./scripts/audit-coderabbit-github.sh --pre-restore alitycs/alitycs-sdk-<name>`. Restore the
app-bound required check only after that audit passes, then run the same audit again without
`--pre-restore` to verify the final three-check protection. Never disable the surrounding CI,
signature, history, conversation, force-push, or deletion protections.

For app-key rotation, add a new GitHub App private key, update the environment secret in every SDK,
run a canary and refresh `ALITYCS_CODERABBIT_GATE_CANARY_SHA` in each repository, and only then
revoke the old key.

#!/usr/bin/env bash

set -euo pipefail

readonly gate_app_slug="alitycs-coderabbit-gate"
readonly gate_check_name="Alitycs CodeRabbit Gate"
readonly gate_environment="coderabbit-gate"
readonly gate_app_id_variable="ALITYCS_CODERABBIT_GATE_APP_ID"
readonly gate_canary_sha_variable="ALITYCS_CODERABBIT_GATE_CANARY_SHA"
readonly gate_client_id_variable="ALITYCS_CODERABBIT_GATE_CLIENT_ID"
readonly gate_secret="ALITYCS_CODERABBIT_GATE_PRIVATE_KEY"
readonly github_actions_app_id="15368"
readonly protected_workflow_tree=".github/workflows"
readonly -a protected_files=(
	".coderabbit.yaml"
)

fail() {
	echo "error: $*" >&2
	exit 1
}

remote_tree_entry() {
	local tree_sha="$1"
	local path="$2"
	local index
	local entry
	local mode
	local type
	local sha
	local tree_json
	local -a segments

	IFS="/" read -r -a segments <<<"$path"
	for ((index = 0; index < ${#segments[@]}; index += 1)); do
		tree_json="$(gh api "repos/$repository/git/trees/$tree_sha")"
		entry="$(jq -r --arg segment "${segments[$index]}" '.tree[] | select(.path == $segment) | [.mode, .type, .sha] | @tsv' <<<"$tree_json")"
		[[ -n "$entry" ]] || return 1
		IFS=$'\t' read -r mode type sha <<<"$entry"
		if ((index == ${#segments[@]} - 1)); then
			printf '%s\t%s\t%s\n' "$mode" "$type" "$sha"
			return
		fi
		[[ "$mode" == "040000" && "$type" == "tree" ]] || return 1
		tree_sha="$sha"
	done
	return 1
}

verify_action_pins() {
	local helper_entry
	local helper_mode
	local helper_path
	local helper_sha
	local helper_type

	helper_entry="$(git ls-tree "$local_head" -- scripts/verify-workflow-pins.rb)"
	[[ -n "$helper_entry" ]] || fail "the workflow-pin verifier is missing from the audited commit"
	read -r helper_mode helper_type helper_sha helper_path <<<"$helper_entry"
	[[ "$helper_mode" == "100755" && "$helper_type" == "blob" &&
		"$helper_path" == "scripts/verify-workflow-pins.rb" ]] ||
		fail "the workflow-pin verifier must be a regular executable blob"
	git show "${local_head}:scripts/verify-workflow-pins.rb" |
		ruby - --git-ref "$local_head" >/dev/null ||
		fail "the audited commit contains mutable or invalid workflow action references"
}

for command_name in gh git jq ruby sort; do
	command -v "$command_name" >/dev/null 2>&1 ||
		fail "required command is unavailable: $command_name"
done

require_gate=true
if [[ "${1:-}" == "--pre-restore" ]]; then
	require_gate=false
	shift
fi
[[ "$#" -le 1 ]] || fail "usage: $0 [--pre-restore] [owner/repository]"

repository="${1:-}"
if [[ -z "$repository" ]]; then
	repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
	fail "repository must use the owner/name form"

owner="${repository%%/*}"
repository_metadata="$(gh api "repos/$repository")"
jq -e '.private == false and .default_branch == "main"' <<<"$repository_metadata" >/dev/null ||
	fail "$repository must be public and use main as its default branch"

installations="$(
	gh api -H "Time-Zone: UTC" --paginate --slurp \
		"orgs/$owner/installations?per_page=100"
)"
installation="$(
	jq -c --arg slug "$gate_app_slug" \
		'first(.[] | .installations[] | select(.app_slug == $slug)) // empty' \
		<<<"$installations"
)"
[[ -n "$installation" ]] || fail "$gate_app_slug is not installed for $owner"
jq -e '
	.suspended_at == null and
	.repository_selection == "selected" and
	.permissions == {
		actions: "read",
		checks: "write",
		contents: "read",
		metadata: "read",
		pull_requests: "read"
	} and
	(.events // []) == []
' <<<"$installation" >/dev/null ||
	fail "$gate_app_slug must use selected repositories with only the documented permissions"

installation_id="$(jq -r '.id // empty' <<<"$installation")"
[[ "$installation_id" =~ ^[1-9][0-9]*$ ]] || fail "could not read the gate App installation ID"
gate_repository_pages="$(
	gh api --paginate --slurp \
		"user/installations/$installation_id/repositories?per_page=100" ||
		fail "could not enumerate the Gate App repositories; gh auth needs read:user and org-owner access"
)"
organization_repository_pages="$(
	gh api --paginate --slurp "orgs/$owner/repos?type=public&per_page=100"
)"
jq -e --slurp --arg owner "$owner" --arg repository "$repository" '
	.[0] as $gate_pages |
	.[1] as $organization_pages |
	[$gate_pages[] | .repositories[]] as $selected |
	[$organization_pages[] | .[] |
		select(
			.owner.login == $owner and
			(.name | test("^alitycs-sdk-[a-z0-9][a-z0-9._-]*$")) and
			.private == false and
			(.visibility // "public") == "public" and
			.archived == false and
			.disabled == false and
			.fork == false and
			.default_branch == "main"
		)
	] as $expected |
	($selected | length) > 0 and
	all($selected[];
		.owner.login == $owner and
		(.name | test("^alitycs-sdk-[a-z0-9][a-z0-9._-]*$")) and
		.private == false and
		(.visibility // "public") == "public" and
		.archived == false and
		.disabled == false and
		.fork == false and
		.default_branch == "main"
	) and
	([$selected[] | select(.full_name == $repository)] | length == 1) and
	(($selected | map(.full_name) | sort) == ($expected | map(.full_name) | sort))
' < <(
	printf '%s\n' "$gate_repository_pages"
	printf '%s\n' "$organization_repository_pages"
) >/dev/null ||
	fail "$gate_app_slug must select every active public SDK and no other repository, including $repository"

coderabbit_installation="$(
	jq -c \
		'first(.[] | .installations[] | select(.app_slug == "coderabbitai")) // empty' \
		<<<"$installations"
)"
[[ -n "$coderabbit_installation" ]] || fail "coderabbitai is not installed for $owner"
jq -e '
	.suspended_at == null and
	.repository_selection == "all" and
	.permissions == {
		actions: "read",
		checks: "write",
		contents: "write",
		discussions: "read",
		issues: "write",
		members: "read",
		metadata: "read",
		pull_requests: "write",
		statuses: "write"
	} and
	(.events | sort) == ([
		"issue_comment",
		"issues",
		"label",
		"organization",
		"pull_request",
		"pull_request_review",
		"pull_request_review_comment",
		"pull_request_review_thread",
		"release",
		"repository"
	] | sort)
' <<<"$coderabbit_installation" >/dev/null ||
	fail "coderabbitai must match the documented permission and webhook allowlists"

gate_app_id="$(jq -r '.app_id // empty' <<<"$installation")"
[[ "$gate_app_id" =~ ^[1-9][0-9]*$ ]] || fail "could not read the gate App ID"
installation_updated_at="$(jq -r '.updated_at // empty' <<<"$installation")"
[[ -n "$installation_updated_at" ]] || fail "could not read the gate App installation update time"
gate_app="$(gh api -H "Time-Zone: UTC" "apps/$gate_app_slug")"
gate_client_id="$(jq -r '.client_id // empty' <<<"$gate_app")"
gate_app_updated_at="$(jq -r '.updated_at // empty' <<<"$gate_app")"
[[ -n "$gate_client_id" ]] || fail "could not read the gate App client ID"
[[ -n "$gate_app_updated_at" ]] || fail "could not read the gate App update time"

environment="$(gh api "repos/$repository/environments/$gate_environment")"
jq -e '
	.deployment_branch_policy.protected_branches == false and
	.deployment_branch_policy.custom_branch_policies == true
' <<<"$environment" >/dev/null ||
	fail "$gate_environment must use custom deployment branches only"

branch_policies="$(
	gh api "repos/$repository/environments/$gate_environment/deployment-branch-policies?per_page=100"
)"
jq -e '
	.branch_policies | length == 1 and
	.[0].name == "main" and
	(.[0].type == null or .[0].type == "branch")
' <<<"$branch_policies" >/dev/null ||
	fail "$gate_environment must allow exactly the main branch"

configured_client_id="$(
	gh api "repos/$repository/actions/variables/$gate_client_id_variable" --jq .value ||
		fail "$gate_client_id_variable is missing from the repository"
)"
[[ -n "$configured_client_id" ]] || fail "$gate_client_id_variable is empty"
[[ "$configured_client_id" == "$gate_client_id" ]] ||
	fail "$gate_client_id_variable does not match the installed gate App"
configured_app_id="$(
	gh api "repos/$repository/actions/variables/$gate_app_id_variable" --jq .value ||
		fail "$gate_app_id_variable is missing from the repository"
)"
[[ -n "$configured_app_id" ]] || fail "$gate_app_id_variable is empty"
[[ "$configured_app_id" == "$gate_app_id" ]] ||
	fail "$gate_app_id_variable does not match the installed gate App"
gate_secret_metadata="$(
	gh api -H "Time-Zone: UTC" \
		"repos/$repository/environments/$gate_environment/secrets/$gate_secret"
)" || fail "$gate_secret is missing from the gate environment"
gate_secret_updated_at="$(jq -r '.updated_at // empty' <<<"$gate_secret_metadata")"
[[ -n "$gate_secret_updated_at" ]] || fail "could not read the gate private-key update time"
canary_sha="$(
	gh api "repos/$repository/actions/variables/$gate_canary_sha_variable" --jq .value ||
		fail "$gate_canary_sha_variable is missing from the repository"
)"
[[ "$canary_sha" =~ ^[0-9a-f]{40}$ ]] ||
	fail "$gate_canary_sha_variable must contain a full lowercase commit SHA"

local_head="$(git rev-parse HEAD)"
git diff --quiet && git diff --cached --quiet ||
	fail "tracked files must be clean before auditing main"
remote_head="$(gh api "repos/$repository/git/ref/heads/main" --jq .object.sha)"
[[ "$local_head" == "$remote_head" ]] ||
	fail "the local checkout must be synchronized exactly to remote main"
remote_root_tree="$(gh api "repos/$repository/git/commits/$remote_head" --jq .tree.sha)"
verify_action_pins

for protected_path in "${protected_files[@]}"; do
	local_entry="$(git ls-tree "$local_head" -- "$protected_path")"
	[[ -n "$local_entry" ]] || fail "local protected file is missing: $protected_path"
	read -r local_mode local_type local_blob local_path <<<"$local_entry"
	[[ "$local_mode" == "100644" && "$local_type" == "blob" && "$local_path" == "$protected_path" ]] ||
		fail "local protected file is not a regular non-executable blob: $protected_path"
	remote_entry="$(remote_tree_entry "$remote_root_tree" "$protected_path")" ||
		fail "remote protected file is missing: $protected_path"
	IFS=$'\t' read -r remote_mode remote_type remote_blob <<<"$remote_entry"
	[[ "$remote_mode" == "100644" && "$remote_type" == "blob" ]] ||
		fail "remote protected file is not a regular non-executable blob: $protected_path"
	[[ "$local_blob" == "$remote_blob" ]] ||
		fail "local and main protected blobs differ: $protected_path"
done

local_workflow_entry="$(git ls-tree "$local_head" -- "$protected_workflow_tree")"
[[ -n "$local_workflow_entry" ]] || fail "local protected workflow tree is missing"
read -r local_workflow_mode local_workflow_type local_workflow_sha local_workflow_path \
	<<<"$local_workflow_entry"
[[ "$local_workflow_mode" == "040000" && "$local_workflow_type" == "tree" &&
	"$local_workflow_path" == "$protected_workflow_tree" ]] ||
	fail "local protected workflow path is not a Git tree"
remote_workflow_entry="$(remote_tree_entry "$remote_root_tree" "$protected_workflow_tree")" ||
	fail "remote protected workflow tree is missing"
IFS=$'\t' read -r remote_workflow_mode remote_workflow_type remote_workflow_sha \
	<<<"$remote_workflow_entry"
[[ "$remote_workflow_mode" == "040000" && "$remote_workflow_type" == "tree" ]] ||
	fail "remote protected workflow path is not a Git tree"
[[ "$local_workflow_sha" == "$remote_workflow_sha" ]] ||
	fail "local and main workflow trees differ"

gate_workflow="$(gh api "repos/$repository/actions/workflows/coderabbit-gate.yml")"
jq -e '
	.path == ".github/workflows/coderabbit-gate.yml" and
	.name == "CodeRabbit gate" and
	.state == "active"
' <<<"$gate_workflow" >/dev/null ||
	fail "the canonical CodeRabbit gate workflow is not registered and active"
signal_workflow="$(gh api "repos/$repository/actions/workflows/coderabbit-review-event.yml")"
jq -e '
	.path == ".github/workflows/coderabbit-review-event.yml" and
	.name == "CodeRabbit review event" and
	.state == "active"
' <<<"$signal_workflow" >/dev/null ||
	fail "the canonical CodeRabbit review-event workflow is not registered and active"

canary_checks="$(
	gh api --method GET --paginate --slurp \
		-H "Accept: application/vnd.github+json" \
		-H "Time-Zone: UTC" \
		"repos/$repository/commits/$canary_sha/check-runs" \
		-f check_name="$gate_check_name" \
		-f filter=all \
		-F per_page=100
)"
jq -e \
	--arg app_updated_at "$gate_app_updated_at" \
	--arg canary_sha "$canary_sha" \
	--arg external_id_prefix "alitycs-coderabbit-gate/v9:" \
	--arg gate_app_slug "$gate_app_slug" \
		--arg gate_check_name "$gate_check_name" \
		--arg installation_updated_at "$installation_updated_at" \
		--arg secret_updated_at "$gate_secret_updated_at" \
	--argjson gate_app_id "$gate_app_id" '
	def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
	[.[] | .check_runs[] |
		select(
			.name == $gate_check_name and
			.head_sha == $canary_sha and
			.app.id == $gate_app_id and
			.app.slug == $gate_app_slug and
			.status == "completed" and
			.conclusion == "success" and
			((.external_id // "") | startswith($external_id_prefix)) and
				(.completed_at | epoch) > ($installation_updated_at | epoch) and
				(.completed_at | epoch) > ($app_updated_at | epoch) and
				(.completed_at | epoch) > ($secret_updated_at | epoch)
		)
	] | length == 1
' <<<"$canary_checks" >/dev/null ||
	fail "the recorded Gate App canary is missing, stale, duplicated, or unsuccessful"

protection="$(gh api "repos/$repository/branches/main/protection")"
jq -e \
	--arg gate_name "$gate_check_name" \
	--argjson actions_app_id "$github_actions_app_id" \
	--argjson gate_app_id "$gate_app_id" \
	--argjson require_gate "$require_gate" '
	.required_status_checks.strict == true and
	(
		if $require_gate then
			(.required_status_checks.checks | length == 3) and
			([.required_status_checks.checks[] |
				select(.context == $gate_name and .app_id == $gate_app_id)] | length == 1)
		else
			(.required_status_checks.checks | length == 2) and
			([.required_status_checks.checks[] |
				select(.context == $gate_name)] | length == 0)
		end
	) and
	([.required_status_checks.checks[] |
		select(.context == "Verify" and .app_id == $actions_app_id)] | length == 1) and
	([.required_status_checks.checks[] |
		select(.context == "Review" and .app_id == $actions_app_id)] | length == 1) and
	.enforce_admins.enabled == true and
	.required_pull_request_reviews.dismiss_stale_reviews == true and
	.required_pull_request_reviews.require_last_push_approval == true and
	.required_pull_request_reviews.required_approving_review_count == 1 and
	((.required_pull_request_reviews.bypass_pull_request_allowances.users // []) | length == 0) and
	((.required_pull_request_reviews.bypass_pull_request_allowances.teams // []) | length == 0) and
	((.required_pull_request_reviews.bypass_pull_request_allowances.apps // []) | length == 0) and
	.required_conversation_resolution.enabled == true and
	.required_linear_history.enabled == true and
	.allow_force_pushes.enabled == false and
	.allow_deletions.enabled == false
' <<<"$protection" >/dev/null ||
	fail "main branch protection does not match the SDK gate policy"

signature_policy="$(gh api "repos/$repository/branches/main/protection/required_signatures")"
jq -e '.enabled == true' <<<"$signature_policy" >/dev/null ||
	fail "signed commits are not required on main"

current_remote_head="$(gh api "repos/$repository/git/ref/heads/main" --jq .object.sha)"
[[ "$current_remote_head" == "$remote_head" ]] ||
	fail "remote main changed during the audit; rerun against the new head"

if [[ "$require_gate" == "true" ]]; then
	echo "CodeRabbit GitHub controls verified for $repository (gate App ID $gate_app_id)."
else
	echo "CodeRabbit pre-restore controls verified for $repository (gate App ID $gate_app_id)."
fi

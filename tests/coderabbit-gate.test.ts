import { describe, expect, test } from "bun:test";

interface ReviewFixture {
  commit_id: string;
  id: number;
  state: string;
  submitted_at: string;
  user: { login: string };
}

interface RunOptions {
  author?: string;
  changedProtectedPath?: string;
  claimLostBeforeFinish?: boolean;
  duplicateHead?: boolean;
  environmentMainOnly?: boolean;
  existingChecksInProgress?: boolean;
  existingGateExternalIds?: string[];
  existingGateCheckIds?: number[];
  gateAppId?: number | null;
  gateAppSlug?: string | null;
  gateChecksError?: Error;
  installationChangesBeforeConclusion?: boolean;
  installationChangesDuringEvaluation?: boolean;
  installationMissingCurrent?: boolean;
  installationToken?: string | null;
  invalidSelectedRepository?: boolean;
  mainChangesBeforeConclusion?: boolean;
  newerGateAppearsAfterCreate?: boolean;
  mainChangesDuringEvaluation?: boolean;
  nonRegularProtectedPath?: string;
  permission?: string;
  recordedBaseSha?: string;
  reviews?: ReviewFixture[];
  reviewsError?: Error;
  runId?: number;
  runAttempt?: number;
  truncatedTree?: boolean;
}

const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
const headSha = "0123456789abcdef0123456789abcdef01234567";
const gateName = "Alitycs CodeRabbit Gate";
const gateAppId = 7654321;
const gateAppSlug = "alitycs-coderabbit-gate";
const policyPath = ".coderabbit.yaml";
const gatePath = ".github/workflows/coderabbit-gate.yml";
const reviewSignalPath = ".github/workflows/coderabbit-review-event.yml";
const workflowTreePath = ".github/workflows";
const protectedObjects = [policyPath, workflowTreePath];
const AsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as new (
  ...arguments_: string[]
) => (...arguments_: unknown[]) => Promise<void>;

async function loadWorkflow() {
  return Bun.YAML.parse(await Bun.file(gatePath).text()) as {
    jobs: {
      route: {
        permissions: Record<string, string>;
        steps: Array<{
          name: string;
          uses?: string;
          with?: { script?: string };
        }>;
      };
      reconcile: {
        environment: string;
        steps: Array<{
          name: string;
          uses?: string;
          with?: { script?: string };
        }>;
      };
    };
    on: Record<string, { branches?: string[]; types?: string[] }>;
    permissions: Record<string, string>;
  };
}

async function loadRouteScript() {
  const workflow = await loadWorkflow();
  const script = workflow.jobs.route.steps.find(
    (step) => step.name === "Route the trusted event",
  )?.with?.script;
  if (!script) throw new Error("Gate router script is missing");
  return script;
}

async function loadGateScript() {
  const workflow = await loadWorkflow();
  const script = workflow.jobs.reconcile.steps.find(
    (step) => step.name === "Publish the current-head gate",
  )?.with?.script;
  if (!script) throw new Error("Gate script is missing");
  return script;
}

async function runPinVerifier(input?: string, label = "fixture.yml") {
  const command = ["ruby", "scripts/verify-workflow-pins.rb"];
  if (input !== undefined) command.push("--stdin", label);
  const child = Bun.spawn(command, {
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function runGate(options: RunOptions = {}) {
  const script = await loadGateScript();
  const listDeploymentBranchPolicies = () => undefined;
  const listGateChecks = () => undefined;
  const listPullRequests = () => undefined;
  const listReviews = () => undefined;
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const failures: string[] = [];
  const installationTokens: string[] = [];
  const notices: string[] = [];
  let checkGetCount = 0;
  let getRefCount = 0;
  let installationInspectionCount = 0;
  const pullRequest = {
    base: { ref: "main", sha: options.recordedBaseSha ?? baseSha },
    draft: false,
    head: { sha: headSha },
    number: 7,
    state: "open",
    user: { login: options.author ?? "maintainer" },
  };
  const gateChecks: Array<Record<string, unknown>> = (
    options.existingGateCheckIds ?? []
  ).map((id, index) => ({
    app: { id: gateAppId, slug: gateAppSlug },
    conclusion: options.existingChecksInProgress ? null : "failure",
    external_id:
      options.existingGateExternalIds?.[index] ?? "previous-reconciliation",
    head_sha: headSha,
    id,
    name: gateName,
    status: options.existingChecksInProgress ? "in_progress" : "completed",
  }));
  const selectedRepositories = [
    {
      archived: false,
      default_branch: "main",
      disabled: false,
      fork: false,
      full_name: "alitycs/alitycs-sdk-js",
      id: 1,
      name: "alitycs-sdk-js",
      owner: { login: "alitycs" },
      private: false,
      visibility: "public",
    },
    {
      archived: false,
      default_branch: "main",
      disabled: false,
      fork: false,
      full_name: "alitycs/alitycs-sdk-jvm",
      id: 2,
      name: "alitycs-sdk-jvm",
      owner: { login: "alitycs" },
      private: false,
      visibility: "public",
    },
  ];
  const invalidRepository = {
    archived: false,
    default_branch: "main",
    disabled: false,
    fork: false,
    full_name: "alitycs/alitycs-api",
    id: 3,
    name: "alitycs-api",
    owner: { login: "alitycs" },
    private: false,
    visibility: "public",
  };
  const paginateInstallation = async (method: unknown) => {
    if (method !== "GET /installation/repositories") {
      throw new Error("Unexpected installation endpoint");
    }
    installationInspectionCount += 1;
    const repositories = options.installationMissingCurrent
      ? selectedRepositories.filter(
          (candidate) => candidate.full_name !== "alitycs/alitycs-sdk-js",
        )
      : [...selectedRepositories];
    if (
      options.invalidSelectedRepository ||
      (options.installationChangesDuringEvaluation &&
        installationInspectionCount > 1) ||
      (options.installationChangesBeforeConclusion &&
        installationInspectionCount > 2)
    ) {
      repositories.push(invalidRepository);
    }
    return repositories;
  };
  const getOctokit = (token: string) => {
    installationTokens.push(token);
    return { paginate: paginateInstallation };
  };
  const github = {
    paginate: async (method: unknown) => {
      if (method === listDeploymentBranchPolicies) {
        return options.environmentMainOnly === false
          ? [{ name: "*" }]
          : [{ name: "main", type: "branch" }];
      }
      if (method === listGateChecks) {
        if (options.gateChecksError) throw options.gateChecksError;
        return gateChecks;
      }
      if (method === listPullRequests) {
        return options.duplicateHead
          ? [
              pullRequest,
              {
                ...pullRequest,
                number: 8,
                user: { login: "another-maintainer" },
              },
            ]
          : [pullRequest];
      }
      if (method === listReviews) {
        if (options.reviewsError) throw options.reviewsError;
        return options.reviews ?? [];
      }
      throw new Error("Unexpected paginated endpoint");
    },
    rest: {
      actions: {
        getWorkflow: async () => ({
          data: {
            id: 77,
            path: reviewSignalPath,
          },
        }),
      },
      checks: {
        create: async (input: Record<string, unknown>) => {
          created.push(input);
          const checkRun = {
            ...input,
            app: { id: gateAppId, slug: gateAppSlug },
            id: 501,
          };
          gateChecks.push(checkRun);
          if (options.newerGateAppearsAfterCreate) {
            gateChecks.push({
              ...checkRun,
              external_id: `alitycs-coderabbit-gate/v9:7:${headSha}:100:1`,
              id: 502,
            });
          }
          return { data: checkRun };
        },
        get: async ({ check_run_id }: { check_run_id: number }) => {
          checkGetCount += 1;
          const checkRun = gateChecks.find(
            (candidate) => candidate.id === check_run_id,
          );
          if (!checkRun) throw new Error("Unknown check run");
          return {
            data:
              options.claimLostBeforeFinish && checkGetCount > 1
                ? { ...checkRun, external_id: "newer-reconciliation" }
                : checkRun,
          };
        },
        listForRef: listGateChecks,
        update: async (input: Record<string, unknown>) => {
          updated.push(input);
          const index = gateChecks.findIndex(
            (candidate) => candidate.id === input.check_run_id,
          );
          if (index >= 0)
            gateChecks[index] = { ...gateChecks[index], ...input };
          return { data: input };
        },
      },
      git: {
        getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
          data: {
            tree: { sha: `root:${commit_sha}` },
          },
        }),
        getRef: async () => {
          getRefCount += 1;
          return {
            data: {
              object: {
                sha:
                  (options.mainChangesDuringEvaluation && getRefCount > 1) ||
                  (options.mainChangesBeforeConclusion && getRefCount > 2)
                    ? "fedcba9876543210fedcba9876543210fedcba98"
                    : baseSha,
              },
            },
          };
        },
        getTree: async ({ tree_sha }: { tree_sha: string }) => {
          const separator = tree_sha.indexOf(":");
          const level = tree_sha.slice(0, separator);
          const ref = tree_sha.slice(separator + 1);
          if (level === "root") {
            return {
              data: {
                truncated: options.truncatedTree === true,
                tree: [
                  {
                    mode:
                      ref === headSha &&
                      options.nonRegularProtectedPath === policyPath
                        ? "120000"
                        : "100644",
                    path: policyPath,
                    sha:
                      ref === headSha &&
                      options.changedProtectedPath === policyPath
                        ? `changed-${policyPath}`
                        : `trusted-${policyPath}`,
                    type: "blob",
                  },
                  {
                    mode: "040000",
                    path: ".github",
                    sha: `github:${ref}`,
                    type: "tree",
                  },
                ],
              },
            };
          }
          if (level === "github") {
            return {
              data: {
                truncated: options.truncatedTree === true,
                tree: [
                  {
                    mode:
                      ref === headSha &&
                      options.nonRegularProtectedPath === workflowTreePath
                        ? "120000"
                        : "040000",
                    path: "workflows",
                    sha:
                      ref === headSha &&
                      options.changedProtectedPath === workflowTreePath
                        ? "changed-workflows"
                        : "trusted-workflows",
                    type: "tree",
                  },
                ],
              },
            };
          }
          if (level !== "workflows") throw new Error("Unexpected tree");
          return {
            data: {
              truncated: options.truncatedTree === true,
              tree: [gatePath, reviewSignalPath].map((path) => ({
                mode:
                  ref === headSha && options.nonRegularProtectedPath === path
                    ? "120000"
                    : "100644",
                path: path.split("/").at(-1),
                sha:
                  ref === headSha && options.changedProtectedPath === path
                    ? `changed-${path}`
                    : `trusted-${path}`,
                type: "blob",
              })),
            },
          };
        },
      },
      pulls: {
        get: async () => ({ data: pullRequest }),
        list: listPullRequests,
        listReviews,
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: options.permission ?? "write" },
        }),
        getEnvironment: async () => ({
          data: {
            deployment_branch_policy:
              options.environmentMainOnly === false
                ? { custom_branch_policies: false, protected_branches: true }
                : { custom_branch_policies: true, protected_branches: false },
          },
        }),
        listDeploymentBranchPolicies,
      },
    },
  };
  const context = {
    actor: "maintainer",
    eventName: "pull_request_target",
    payload: { pull_request: pullRequest },
    repo: { owner: "alitycs", repo: "alitycs-sdk-js" },
    runAttempt: options.runAttempt ?? 1,
    runId: options.runId ?? 99,
  };
  const core = {
    error: (message: string) => errors.push(message),
    info: () => undefined,
    notice: (message: string) => notices.push(message),
    setFailed: (message: string) => failures.push(message),
  };
  const execute = new AsyncFunction(
    "github",
    "context",
    "core",
    "getOctokit",
    "process",
    script,
  );
  const env: Record<string, string> = { PULL_REQUEST_NUMBER: "7" };
  if (options.gateAppId !== null) {
    env.GATE_APP_ID = String(options.gateAppId ?? gateAppId);
  }
  if (options.gateAppSlug !== null) {
    env.GATE_APP_SLUG = options.gateAppSlug ?? gateAppSlug;
  }
  if (options.installationToken !== null) {
    env.INSTALLATION_TOKEN = options.installationToken ?? "installation-token";
  }
  await execute(github, context, core, getOctokit, { env });
  return {
    created,
    errors,
    failures,
    gateChecks,
    installationTokens,
    notices,
    updated,
  };
}

async function runRoute(
  options: {
    actor?: string;
    canonicalId?: number;
    canonicalName?: string;
    canonicalPath?: string;
    collaboratorForbidden?: boolean;
    collaboratorNotFound?: boolean;
    collaboratorPermission?: string;
    dispatchInput?: unknown;
    emptyPullRequests?: boolean;
    eventName?:
      | "issue_comment"
      | "pull_request_target"
      | "push"
      | "workflow_dispatch"
      | "workflow_run";
    headSha?: string;
    matchingPullRequests?: number;
    pullRequestAction?: "edited" | "opened";
    pullRequestBaseChanged?: boolean;
    runId?: number;
    runPath?: string;
  } = {},
) {
  const script = await loadRouteScript();
  const outputs: Record<string, string> = {};
  const failures: string[] = [];
  const warnings: string[] = [];
  const eventName = options.eventName ?? "workflow_run";
  const listPullRequests = () => undefined;
  const context = {
    actor: options.actor ?? "github-actions[bot]",
    eventName,
    payload:
      eventName === "issue_comment"
        ? { comment: { body: "/coderabbit-gate" }, issue: { number: 7 } }
        : eventName === "pull_request_target"
          ? {
              action: options.pullRequestAction ?? "opened",
              changes: options.pullRequestBaseChanged
                ? { base: { ref: { from: "develop" } } }
                : {},
              pull_request: { number: 7 },
            }
          : eventName === "workflow_dispatch"
            ? { inputs: { pull_request: options.dispatchInput ?? "7" } }
            : eventName === "push"
              ? {}
              : {
                  workflow_run: {
                    actor: { login: options.actor ?? "github-actions[bot]" },
                    event: "pull_request_review",
                    head_sha: options.headSha ?? headSha,
                    path: options.runPath ?? reviewSignalPath,
                    pull_requests: options.emptyPullRequests
                      ? []
                      : [{ number: 7 }],
                    workflow_id: options.runId ?? 77,
                  },
                },
    repo: { owner: "alitycs", repo: "alitycs-sdk-js" },
  };
  const github = {
    paginate: async (method: unknown) => {
      if (method === listPullRequests) {
        return Array.from(
          { length: options.matchingPullRequests ?? 1 },
          (_, index) => ({
            base: { ref: "main" },
            head: { sha: headSha },
            merge_commit_sha: options.headSha ?? headSha,
            number: 7 + index,
            state: "open",
          }),
        );
      }
      throw new Error("Unexpected paginated endpoint");
    },
    rest: {
      actions: {
        getWorkflow: async () => ({
          data: {
            id: options.canonicalId ?? 77,
            name: options.canonicalName ?? "CodeRabbit review event",
            path: options.canonicalPath ?? reviewSignalPath,
          },
        }),
      },
      pulls: {
        list: listPullRequests,
      },
      repos: {
        getCollaboratorPermissionLevel: async () => {
          if (options.collaboratorForbidden) {
            throw Object.assign(new Error("Forbidden"), { status: 403 });
          }
          if (options.collaboratorNotFound) {
            throw Object.assign(new Error("Not found"), { status: 404 });
          }
          return {
            data: { permission: options.collaboratorPermission ?? "write" },
          };
        },
      },
    },
  };
  const core = {
    notice: () => undefined,
    setFailed: (message: string) => failures.push(message),
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
    warning: (message: string) => warnings.push(message),
  };
  const execute = new AsyncFunction("github", "context", "core", script);
  await execute(github, context, core);
  return { failures, outputs, warnings };
}

function review(
  login: string,
  state: string,
  submittedAt: string,
  commitId = headSha,
  id = 1,
): ReviewFixture {
  return {
    commit_id: commitId,
    id,
    state,
    submitted_at: submittedAt,
    user: { login },
  };
}

describe("trusted CodeRabbit workflow", () => {
  test("runs from trusted triggers and protects the unprivileged review signal", async () => {
    const workflow = await loadWorkflow();
    const signalText = await Bun.file(reviewSignalPath).text();
    const signal = Bun.YAML.parse(signalText) as {
      on: Record<string, { branches?: string[]; types?: string[] }>;
      permissions: Record<string, string>;
    };

    expect(workflow.on.pull_request_target?.branches).toEqual(["main"]);
    expect(workflow.on.pull_request_target?.types).toContain("edited");
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.workflow_run).toBeDefined();
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.pull_request_review).toBeUndefined();
    expect(workflow.permissions).toEqual({});
    expect("concurrency" in workflow).toBe(false);
    expect(workflow.jobs.route.permissions).toEqual({
      actions: "read",
      "pull-requests": "read",
    });
    expect(workflow.jobs.reconcile.environment).toBe("coderabbit-gate");
    const gateText = await Bun.file(gatePath).text();
    expect(gateText).not.toContain("actions/checkout");
    expect(gateText).toContain("Mint the selected-repository inspection token");
    expect(gateText).toContain("owner: ${{ github.repository_owner }}");
    expect(gateText).toContain("permission-contents: read");
    expect(gateText).toContain("getOctokit(installationToken)");
    expect(gateText).toContain('"GET /installation/repositories"');
    expect(gateText).toContain(
      "const sdkRepositoryPattern = /^alitycs-sdk-[a-z0-9]+(?:-[a-z0-9]+)*$/;",
    );
    expect(await loadRouteScript()).toContain('context.eventName === "push"');
    expect(signal.on.pull_request_review?.branches).toBeUndefined();
    expect(signal.on.pull_request_review?.types).toEqual([
      "submitted",
      "dismissed",
    ]);
    expect(signal.permissions).toEqual({});
    expect(signalText).not.toMatch(
      /actions\/checkout|secrets\.|environment:|concurrency:/,
    );
  });

  test("builds releases without publish credentials and only from main history", async () => {
    const releaseText = await Bun.file(".github/workflows/release.yml").text();
    const release = Bun.YAML.parse(releaseText) as {
      permissions: Record<string, string>;
      jobs: {
        build: { permissions: Record<string, string> };
        release: {
          needs: string;
          permissions: Record<string, string>;
        };
      };
    };

    expect(release.permissions).toEqual({});
    expect(release.jobs.build.permissions).toEqual({ contents: "read" });
    expect(release.jobs.release.needs).toBe("build");
    expect(release.jobs.release.permissions).toEqual({
      attestations: "write",
      contents: "write",
      "id-token": "write",
    });
    expect(releaseText).toContain("persist-credentials: false");
    expect(releaseText).toContain(
      'git fetch --no-tags --force origin "+refs/heads/main:refs/remotes/origin/main"',
    );
    expect(releaseText).toContain('git cat-file -t "$GITHUB_REF"');
    expect(releaseText).toContain(
      'git merge-base --is-ancestor "$tag_commit" "$main_commit"',
    );
    expect(releaseText).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(releaseText).toMatch(/actions\/download-artifact@[0-9a-f]{40}/);
  });

  test("gates the exact head using current-head CodeRabbit approval", async () => {
    const result = await runGate({
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });
    expect(result.failures).toEqual([]);
    expect(result.installationTokens).toEqual(["installation-token"]);
    expect(result.created[0]).toMatchObject({
      external_id: `alitycs-coderabbit-gate/v9:7:${headSha}:99:1`,
      head_sha: headSha,
      name: gateName,
      status: "in_progress",
    });
    expect(result.updated.at(-1)).toMatchObject({
      conclusion: "success",
      status: "completed",
    });
  });

  test("fails closed for stale approval", async () => {
    const result = await runGate({
      reviews: [
        review(
          "coderabbitai[bot]",
          "APPROVED",
          "2026-08-23T12:00:00Z",
          "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        ),
      ],
    });
    expect(result.failures).toHaveLength(1);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("comment-only review does not erase approval", async () => {
    const result = await runGate({
      reviews: [
        review(
          "coderabbitai[bot]",
          "APPROVED",
          "2026-08-23T12:00:00Z",
          headSha,
          1,
        ),
        review(
          "coderabbitai[bot]",
          "COMMENTED",
          "2026-08-23T12:01:00Z",
          headSha,
          2,
        ),
      ],
    });
    expect(result.failures).toEqual([]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "success" });
  });

  test("later changes-requested review supersedes approval", async () => {
    const result = await runGate({
      reviews: [
        review(
          "coderabbitai[bot]",
          "APPROVED",
          "2026-08-23T12:00:00Z",
          headSha,
          1,
        ),
        review(
          "coderabbitai[bot]",
          "CHANGES_REQUESTED",
          "2026-08-23T12:01:00Z",
          headSha,
          2,
        ),
      ],
    });
    expect(result.failures).toHaveLength(1);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("ignored bot needs a current-head write-access human approval", async () => {
    const approved = await runGate({
      author: "dependabot[bot]",
      reviews: [review("maintainer", "APPROVED", "2026-08-23T12:00:00Z")],
    });
    expect(approved.failures).toEqual([]);

    const readOnly = await runGate({
      author: "dependabot[bot]",
      permission: "read",
      reviews: [review("reader", "APPROVED", "2026-08-23T12:00:00Z")],
    });
    expect(readOnly.failures).toHaveLength(1);
    expect(readOnly.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("ignored bot rejects approvals from bot accounts", async () => {
    const result = await runGate({
      author: "dependabot[bot]",
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });
    expect(result.failures).toHaveLength(1);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("rejects changes to the policy blob or complete workflow tree", async () => {
    for (const changedProtectedPath of protectedObjects) {
      const result = await runGate({
        changedProtectedPath,
        reviews: [
          review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
        ],
      });
      expect(result.failures[0]).toContain(changedProtectedPath);
      expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
    }
  });

  test("rejects a protected policy or workflow replaced by a symlink", async () => {
    for (const nonRegularProtectedPath of protectedObjects) {
      const result = await runGate({
        nonRegularProtectedPath,
        reviews: [
          review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
        ],
      });
      expect(result.failures[0]).toContain(nonRegularProtectedPath);
      expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
    }
  });

  test("fails closed when a Git tree response is truncated", async () => {
    const result = await runGate({ truncatedTree: true });

    expect(result.errors[0]).toContain("was truncated");
    expect(result.failures).toEqual([
      "The trusted CodeRabbit gate failed closed.",
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("fails closed when another open pull request shares the head commit", async () => {
    const result = await runGate({
      duplicateHead: true,
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });
    expect(result.failures).toEqual([
      "The head commit must belong to exactly one open pull request targeting main.",
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("supersedes a completed check and creates a fresh canonical check", async () => {
    const result = await runGate({
      existingGateCheckIds: [401],
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
      runId: 100,
    });

    expect(result.created).toHaveLength(1);
    expect(result.updated[0]).toMatchObject({
      check_run_id: 401,
      conclusion: "neutral",
      name: `${gateName} (superseded 401)`,
      status: "completed",
    });
    expect(result.updated.at(-1)).toMatchObject({
      check_run_id: 501,
      conclusion: "success",
      status: "completed",
    });
    expect(
      result.gateChecks.filter((checkRun) => checkRun.name === gateName),
    ).toHaveLength(1);
    expect(await loadGateScript()).toContain("listForRef");
  });

  test("supersedes an in-progress owned check before reconciling", async () => {
    const result = await runGate({
      existingChecksInProgress: true,
      existingGateCheckIds: [401],
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.updated[0]).toMatchObject({
      check_run_id: 401,
      conclusion: "neutral",
      name: `${gateName} (superseded 401)`,
      status: "completed",
    });
    expect(result.updated.at(-1)).toMatchObject({
      check_run_id: 501,
      conclusion: "success",
      status: "completed",
    });
  });

  test("normalizes duplicate app-owned checks before publishing success", async () => {
    const result = await runGate({
      existingGateCheckIds: [401, 402],
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(
      result.gateChecks.filter((checkRun) => checkRun.name === gateName),
    ).toEqual([expect.objectContaining({ conclusion: "success", id: 501 })]);
    for (const id of [401, 402]) {
      expect(result.gateChecks).toContainEqual(
        expect.objectContaining({
          conclusion: "neutral",
          id,
          name: `${gateName} (superseded ${id})`,
        }),
      );
    }
  });

  test("yields without creating when a newer reconciliation already owns the check", async () => {
    const result = await runGate({
      existingGateCheckIds: [401],
      existingGateExternalIds: [
        `alitycs-coderabbit-gate/v9:7:${headSha}:100:1`,
      ],
      runId: 99,
    });

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.notices).toContain(
      "A newer reconciliation already owns the exact-head gate check.",
    );
  });

  test("supersedes its fresh check when a newer claim appears concurrently", async () => {
    const result = await runGate({
      newerGateAppearsAfterCreate: true,
      runId: 99,
    });

    expect(result.created).toHaveLength(1);
    expect(result.updated).toContainEqual(
      expect.objectContaining({
        check_run_id: 501,
        conclusion: "neutral",
        name: `${gateName} (superseded 501)`,
      }),
    );
    expect(
      result.gateChecks.filter((checkRun) => checkRun.name === gateName),
    ).toEqual([expect.objectContaining({ id: 502 })]);
    expect(result.notices).toContain(
      "A newer reconciliation won the exact-head gate claim.",
    );
  });

  test("does not overwrite a newer reconciliation claim", async () => {
    const result = await runGate({
      claimLostBeforeFinish: true,
      existingGateCheckIds: [401],
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.notices).toContain(
      "A newer reconciliation owns the exact-head gate check.",
    );
    expect(result.updated).not.toContainEqual(
      expect.objectContaining({ conclusion: "success" }),
    );
  });

  test("compares protected objects with the live main ref, not recorded base SHA", async () => {
    const result = await runGate({
      recordedBaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "success" });
  });

  test("fails closed when main advances during evaluation", async () => {
    const result = await runGate({
      mainChangesDuringEvaluation: true,
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });

    expect(result.failures).toEqual([
      "The pull request changed while its exact-head approval was evaluated.",
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("rechecks main immediately before the gate conclusion", async () => {
    const result = await runGate({
      mainChangesBeforeConclusion: true,
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });

    expect(result.failures).toEqual([
      `The trusted main branch changed before the gate conclusion. Compared base ${baseSha}.`,
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("fails the workflow when canonical check discovery fails", async () => {
    const result = await runGate({
      gateChecksError: new Error("check list failed"),
    });

    expect(result.created).toEqual([]);
    expect(result.errors).toEqual([
      "Gate evaluator error: check list failed",
      "The evaluator error could not claim the canonical gate check.",
    ]);
    expect(result.failures).toEqual([
      "The trusted CodeRabbit gate failed closed.",
    ]);
  });

  test("fails before publishing when the dedicated app identity is missing", async () => {
    for (const identity of [
      { gateAppId: null },
      { gateAppSlug: null },
      { installationToken: null },
    ]) {
      const result = await runGate(identity);
      expect(result.failures).toEqual([
        "The dedicated gate app identity is unavailable.",
      ]);
      expect(result.created).toEqual([]);
      expect(result.updated).toEqual([]);
    }
  });

  test("fails the app-owned check when the environment is not main-only", async () => {
    const result = await runGate({ environmentMainOnly: false });
    expect(result.failures).toEqual([
      "The coderabbit-gate environment must allow exactly the main branch.",
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("fails when the selected installation omits the current SDK", async () => {
    const result = await runGate({ installationMissingCurrent: true });

    expect(result.failures[0]).toContain(
      "The Gate App installation must contain this repository",
    );
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("fails when the selected installation contains a non-SDK repository", async () => {
    const result = await runGate({ invalidSelectedRepository: true });

    expect(result.failures[0]).toContain("alitycs-api");
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("fails when selected-repository membership changes during evaluation", async () => {
    const result = await runGate({ installationChangesDuringEvaluation: true });

    expect(result.failures).toEqual([
      "The Gate App selected-repository boundary changed or became unsafe during evaluation.",
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("rechecks selected-repository membership before the conclusion", async () => {
    const result = await runGate({ installationChangesBeforeConclusion: true });

    expect(result.failures).toEqual([
      "The Gate App selected-repository boundary changed or became unsafe before the gate conclusion.",
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("accepts only the canonical review-signal workflow run", async () => {
    const accepted = await runRoute();
    expect(accepted.failures).toEqual([]);
    expect(accepted.outputs).toEqual({
      has_pull_requests: "true",
      pull_requests: "[7]",
    });

    const rejected = await runRoute({
      runId: 88,
      runPath: ".github/workflows/attacker.yml",
    });
    expect(rejected.failures).toEqual([
      "Rejected a non-canonical review-signal workflow run.",
    ]);
    expect(rejected.outputs).toEqual({
      has_pull_requests: "false",
      pull_requests: "[]",
    });
  });

  test("fans a main push out to every open pull request", async () => {
    const result = await runRoute({
      eventName: "push",
      matchingPullRequests: 3,
    });

    expect(result.failures).toEqual([]);
    expect(result.outputs).toEqual({
      has_pull_requests: "true",
      pull_requests: "[7,8,9]",
    });
  });

  test("routes only a valid manually dispatched pull-request number", async () => {
    const valid = await runRoute({
      dispatchInput: "42",
      eventName: "workflow_dispatch",
    });
    expect(valid.failures).toEqual([]);
    expect(valid.outputs).toEqual({
      has_pull_requests: "true",
      pull_requests: "[42]",
    });

    const invalid = await runRoute({
      dispatchInput: "not-a-number",
      eventName: "workflow_dispatch",
    });
    expect(invalid.failures).toEqual([
      "A valid pull-request number is required.",
    ]);
    expect(invalid.outputs).toEqual({
      has_pull_requests: "false",
      pull_requests: "[]",
    });
  });

  test("accepts review signals only from CodeRabbit or current writers", async () => {
    for (const accepted of [
      await runRoute({
        actor: "coderabbitai[bot]",
        collaboratorPermission: "read",
      }),
      await runRoute({ actor: "writer", collaboratorPermission: "write" }),
    ]) {
      expect(accepted.failures).toEqual([]);
      expect(accepted.outputs).toEqual({
        has_pull_requests: "true",
        pull_requests: "[7]",
      });
    }

    for (const rejected of [
      await runRoute({ actor: "reader", collaboratorPermission: "read" }),
      await runRoute({ actor: "outsider", collaboratorNotFound: true }),
    ]) {
      expect(rejected.failures).toEqual([]);
      expect(rejected.outputs).toEqual({
        has_pull_requests: "false",
        pull_requests: "[]",
      });
    }
  });

  test("treats an unavailable collaborator permission lookup as untrusted", async () => {
    const result = await runRoute({
      actor: "unknown",
      collaboratorForbidden: true,
    });

    expect(result.failures).toEqual([]);
    expect(result.outputs).toEqual({
      has_pull_requests: "false",
      pull_requests: "[]",
    });
    expect(result.warnings).toEqual([
      "The router token cannot read collaborator permission; treating the actor as untrusted.",
    ]);
  });

  test("reconciles edited pull requests only when the base changes", async () => {
    const ordinaryEdit = await runRoute({
      eventName: "pull_request_target",
      pullRequestAction: "edited",
    });
    expect(ordinaryEdit.outputs).toEqual({
      has_pull_requests: "false",
      pull_requests: "[]",
    });

    const baseEdit = await runRoute({
      eventName: "pull_request_target",
      pullRequestAction: "edited",
      pullRequestBaseChanged: true,
    });
    expect(baseEdit.outputs).toEqual({
      has_pull_requests: "true",
      pull_requests: "[7]",
    });
  });

  test("resolves fork review signals from source or merge SHAs", async () => {
    const mergeSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (const runHeadSha of [headSha, mergeSha]) {
      const result = await runRoute({
        emptyPullRequests: true,
        headSha: runHeadSha,
      });

      expect(result.failures).toEqual([]);
      expect(result.outputs).toEqual({
        has_pull_requests: "true",
        pull_requests: "[7]",
      });
    }
  });

  test("rejects ambiguous or missing fork signal associations", async () => {
    for (const matchingPullRequests of [0, 2]) {
      const result = await runRoute({
        emptyPullRequests: true,
        matchingPullRequests,
      });
      expect(result.failures).toEqual([
        "The canonical review signal must resolve to exactly one open main pull request.",
      ]);
      expect(result.outputs).toEqual({
        has_pull_requests: "false",
        pull_requests: "[]",
      });
    }
  });

  test("authorizes the maintainer command with current repository permission", async () => {
    const write = await runRoute({
      actor: "writer",
      collaboratorPermission: "write",
      eventName: "issue_comment",
    });
    expect(write.failures).toEqual([]);
    expect(write.outputs).toEqual({
      has_pull_requests: "true",
      pull_requests: "[7]",
    });

    for (const rejected of [
      await runRoute({
        actor: "reader",
        collaboratorPermission: "read",
        eventName: "issue_comment",
      }),
      await runRoute({
        actor: "outsider",
        collaboratorNotFound: true,
        eventName: "issue_comment",
      }),
    ]) {
      expect(rejected.failures).toEqual([]);
      expect(rejected.outputs).toEqual({
        has_pull_requests: "false",
        pull_requests: "[]",
      });
    }
  });

  test("logs evaluator errors and publishes a fail-closed conclusion", async () => {
    const result = await runGate({
      reviewsError: new Error("review API failed"),
    });
    expect(result.errors).toEqual(["Gate evaluator error: review API failed"]);
    expect(result.failures).toEqual([
      "The trusted CodeRabbit gate failed closed.",
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  test("keeps the ignored-bot policy synchronized with the gate", async () => {
    const policy = Bun.YAML.parse(
      await Bun.file(".coderabbit.yaml").text(),
    ) as {
      reviews: { auto_review: { ignore_usernames: string[] } };
    };
    const script = await loadGateScript();
    const ignoredBlock = script.match(
      /const ignoredBots = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1];
    if (!ignoredBlock) throw new Error("Gate ignored-bot set is missing");
    const workflowBots = [...ignoredBlock.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(workflowBots.sort()).toEqual(
      [...policy.reviews.auto_review.ignore_usernames].sort(),
    );
  });

  test("limits pinned validation to relevant pull-request inputs", async () => {
    const ci = await Bun.file(".github/workflows/ci.yml").text();
    const docs = await Bun.file("docs/coderabbit.md").text();
    const validator = await Bun.file("scripts/validate-coderabbit.sh").text();
    const requirements = await Bun.file(
      "scripts/coderabbit-validator-requirements.txt",
    ).text();
    expect(ci).toContain("Detect CodeRabbit validation input changes");
    expect(ci).toContain(
      "if: steps.coderabbit-config.outputs.changed == 'true'",
    );
    for (const validationPath of [
      ".coderabbit.yaml",
      "scripts/coderabbit-schema.v2.json",
      "scripts/coderabbit-validator-requirements.txt",
      "scripts/validate-coderabbit.sh",
    ]) {
      expect(ci).toContain(`"${validationPath}"`);
    }
    expect(ci).toContain(
      'git diff --quiet "$BASE_SHA" "$HEAD_SHA" -- "${validation_paths[@]}"',
    );
    expect(ci).toContain("./scripts/verify-workflow-pins.rb");
    expect(ci).toMatch(/actions\/setup-python@[0-9a-f]{40}/);
    expect(ci).toContain('python-version: "3.14.7"');
    expect(ci).toMatch(/ruby\/setup-ruby@[0-9a-f]{40}/);
    expect(ci).toContain('ruby-version: "3.3.12"');
    expect(validator).toContain("--require-hashes");
    expect(validator).toContain("coderabbit-schema.v2.json");
    expect(validator).not.toContain("command -v check-jsonschema");
    expect(validator).not.toContain("https://coderabbit.ai");
    expect(validator).toContain('readonly python_bin="${PYTHON_BIN:-python3}"');
    expect(validator).toContain(
      "not (3, 11) <= sys.version_info[:2] <= (3, 14)",
    );
    expect(validator).toContain("requires CPython 3.11 through 3.14");
    expect(validator).not.toMatch(
      /readonly (?:script_dir|repository_root)="\$\(/,
    );
    expect(requirements).toContain("check-jsonschema==0.37.4");
    expect(requirements).toContain("--hash=sha256:");
    expect(requirements).toContain(
      "# printf 'check-jsonschema==0.37.4\\n' | uv pip compile",
    );
    expect(requirements).not.toContain(
      "# printf 'check-jsonschema==0.37.4\\\\n' | uv pip compile",
    );
    expect(
      docs.match(/\.\/scripts\/validate-coderabbit\.sh/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    expect(docs).toMatch(
      /From a clean checkout of the merged `main`, rerun `\.\/scripts\/verify-workflow-pins\.rb`,\s+`\.\/scripts\/validate-coderabbit\.sh`, and the repository policy tests, then open/s,
    );
    expect(docs).toMatch(
      /From a clean checkout of the new `main`, rerun the workflow-pin\s+verifier, pinned-schema validator, and policy tests before opening a canary/s,
    );
  });

  test("monitors live schema drift without making it a merge gate", async () => {
    const workflow = await Bun.file(
      ".github/workflows/coderabbit-schema-drift.yml",
    ).text();
    const docs = await Bun.file("docs/coderabbit.md").text();
    const policy = await Bun.file(".coderabbit.yaml").text();

    expect(workflow).toMatch(/^  schedule:$/m);
    expect(workflow).toMatch(/^  workflow_dispatch:$/m);
    expect(workflow).not.toMatch(/^  pull_request(?:_target)?:$/m);
    expect(workflow).not.toMatch(/^  push:$/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "https://coderabbit.ai/integrations/schema.v2.json",
    );
    expect(workflow).toContain('cmp --silent "$pinned_schema" "$live_schema"');
    expect(workflow).not.toMatch(/readonly [a-z_]+="\$\(/);
    expect(docs).toContain("deliberately not a required merge check");
    expect(policy).toContain(
      "keep the scheduled live-schema drift check non-gating",
    );
    expect(policy).toMatch(
      /Initial SDK\s+bootstrap follows the documented seed procedure/,
    );
  });

  test("audits the synchronized commit and exact app allowlists", async () => {
    const audit = await Bun.file("scripts/audit-coderabbit-github.sh").text();
    const docs = await Bun.file("docs/coderabbit.md").text();

    expect(audit).toContain(
      'git show "${local_head}:scripts/verify-workflow-pins.rb"',
    );
    expect(audit).toContain('ruby - --git-ref "$local_head"');
    expect(audit).toContain(
      'readonly protected_workflow_tree=".github/workflows"',
    );
    expect(audit).toContain('.repository_selection == "selected"');
    expect(audit).toContain("ALITYCS_CODERABBIT_GATE_CANARY_SHA");
    expect(audit).toContain('"alitycs-coderabbit-gate/v9:"');
    expect(audit).toContain("fromdateiso8601");
    expect(audit).toContain('-H "Time-Zone: UTC"');
    expect(audit).toContain("$installation_updated_at");
    expect(audit).toContain("$app_updated_at");
    expect(audit).toContain("$gate_secret_updated_at");
    expect(audit).toContain("$secret_updated_at");
    for (const cutoff of [
      "$installation_updated_at",
      "$app_updated_at",
      "$secret_updated_at",
    ]) {
      expect(audit).toContain(`> (${cutoff} | epoch)`);
    }
    expect(audit).toContain(".required_status_checks.checks | length == 3");
    expect(audit).toContain(".permissions == {");
    expect(audit).not.toContain(".permissions.checks ==");
    expect(audit).toContain("(.events // []) == []");
    expect(audit).toContain("(.events | sort) == ([");
    expect(audit).toContain("first(.[] | .installations[] | select(");
    expect(audit).not.toContain("head -n 1");
    expect(audit).toContain(
      '"user/installations/$installation_id/repositories?per_page=100"',
    );
    expect(audit).toContain("must select every active public SDK");
    expect(audit).toContain('gh api "repos/$repository_name"');
    expect(audit).toContain("def active_public_sdk:");
    expect(audit).toContain("((.archived // false) == false)");
    expect(audit).toContain("((.disabled // false) == false)");
    expect(audit).not.toContain('(.default_branch // "main")');
    const sdkRepositoryPattern = /^alitycs-sdk-[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const name of [
      "alitycs-sdk-js",
      "alitycs-sdk-jvm",
      "alitycs-sdk-react-native",
    ]) {
      expect(sdkRepositoryPattern.test(name)).toBe(true);
    }
    for (const name of [
      "alitycs-sdk-cpp.v2",
      "alitycs-sdk-cpp_v2",
      "alitycs-sdk--go",
      "alitycs-sdk-go-",
      "Alitycs-sdk-go",
    ]) {
      expect(sdkRepositoryPattern.test(name)).toBe(false);
    }
    expect(audit).toContain(
      "readonly sdk_repository_pattern='^alitycs-sdk-[a-z0-9]+(-[a-z0-9]+)*$'",
    );
    expect(audit.match(/test\(\$sdk_pattern\)/g)?.length).toBe(2);
    expect(docs).toContain("lowercase alphanumeric name segments");
    expect(audit).toContain('--argjson require_gate "$require_gate"');
    expect(audit).toContain('if [[ "${1:-}" == "--pre-restore" ]]');
    expect(docs).toContain(
      "./scripts/audit-coderabbit-github.sh --pre-restore",
    );
    expect(docs).toContain("run the same audit again without");
    expect(audit).toContain('fail "could not read the gate App ID"');
    for (const variable of [
      "$gate_client_id_variable",
      "$gate_app_id_variable",
      "$gate_canary_sha_variable",
    ]) {
      expect(audit).toContain(
        `fail "${variable} is missing from the repository"`,
      );
    }
  });

  test("structurally rejects mutable GitHub and Docker action references", async () => {
    const current = await runPinVerifier();
    expect(current.exitCode).toBe(0);
    expect(current.stdout).toContain("immutable third-party");

    const invalid = await runPinVerifier(`
anchors:
  action: &mutable-action actions/checkout@v4
  key: &uses-key uses
jobs:
  reusable:
    uses: alitycs/reusable/.github/workflows/ci.yml@main
  invalid-local-workflow:
    uses: $/.github/actions/not-a-workflow
  invalid:
    steps:
      - "uses" : actions/checkout@v4
      - { uses: actions/setup-node@v4 }
      - uses: docker://alpine:latest
      - uses: $/.github/workflows/not-an-action.yml
      - uses: $/.github/actions/local-action@main
      - *uses-key: *mutable-action
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        uses: actions/cache@v4
`);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain(
      '"alitycs/reusable/.github/workflows/ci.yml@main"',
    );
    expect(invalid.stderr).toContain('"actions/checkout@v4"');
    expect(invalid.stderr).toContain('"actions/setup-node@v4"');
    expect(invalid.stderr).toContain('"docker://alpine:latest"');
    expect(invalid.stderr).toContain('"actions/cache@v4"');
    expect(invalid.stderr).toContain('"$/.github/actions/not-a-workflow"');
    expect(invalid.stderr).toContain('"$/.github/workflows/not-an-action.yml"');
    expect(invalid.stderr).toContain('"$/.github/actions/local-action@main"');

    const flowRedefinition = await runPinVerifier(`
{ jobs: { invalid: { steps: [{ uses: &pin actions/checkout@v4 }, { uses: *pin }] } }, later: &pin actions/checkout@${"e".repeat(40)} }
`);
    expect(flowRedefinition.exitCode).toBe(1);
    expect(
      flowRedefinition.stderr.match(/"actions\/checkout@v4"/g)?.length,
    ).toBe(2);

    const laterRedefinition = await runPinVerifier(`
defaults: &pin actions/checkout@v4
jobs:
  invalid:
    steps:
      - uses: *pin
later: &pin actions/checkout@${"f".repeat(40)}
`);
    expect(laterRedefinition.exitCode).toBe(1);
    expect(laterRedefinition.stderr).toContain('"actions/checkout@v4"');

    const validRedefinition = await runPinVerifier(`
earlier: &pin actions/checkout@v4
current: &pin actions/checkout@${"1".repeat(40)}
jobs:
  valid:
    steps:
      - uses: *pin
`);
    expect(validRedefinition.exitCode).toBe(0);

    const crossDocumentAlias = await runPinVerifier(`
defaults: &pin actions/checkout@${"2".repeat(40)}
---
jobs:
  invalid:
    steps:
      - uses: *pin
`);
    expect(crossDocumentAlias.exitCode).toBe(1);
    expect(crossDocumentAlias.stderr).toContain("uses must be a scalar string");

    const valid = await runPinVerifier(`
env:
  uses: actions/root-environment@v4
jobs:
  valid:
    uses: alitycs/reusable/.github/workflows/ci.yml@${"a".repeat(40)}
    with:
      uses: actions/reusable-input@v4
  same-commit-workflow:
    uses: $/.github/workflows/ci.yml
  actions:
    env:
      uses: actions/job-environment@v4
    steps:
      - "uses": actions/checkout@${"b".repeat(40)}
        with:
          uses: actions/action-input@v4
        env:
          uses: actions/step-environment@v4
      - { uses: "docker://ghcr.io/alitycs/build@sha256:${"c".repeat(64)}" }
      - uses: ./local-action
      - uses: $/.github/actions/local-action
`);
    expect(valid.exitCode).toBe(0);

    const validComposite = await runPinVerifier(
      `
name: Fixture composite action
description: Exercises non-action uses keys
inputs:
  uses:
    description: A harmless input named uses
    required: false
runs:
  using: composite
  steps:
    - shell: bash
      run: echo ok
      env:
        uses: actions/composite-environment@v4
    - uses: actions/checkout@${"d".repeat(40)}
      with:
        uses: actions/composite-input@v4
    - uses: $/.github/actions/composite-local
`,
      "action.yml",
    );
    expect(validComposite.exitCode).toBe(0);

    const invalidComposite = await runPinVerifier(
      `
name: Fixture composite action
description: Contains a real mutable action reference
inputs:
  uses:
    description: A harmless input named uses
runs:
  using: composite
  steps:
    - uses: actions/checkout@v4
      with:
        uses: actions/harmless-input@v4
    - uses: $/.github/workflows/not-an-action.yml
`,
      "action.yaml",
    );
    expect(invalidComposite.exitCode).toBe(1);
    expect(invalidComposite.stderr).toContain('"actions/checkout@v4"');
    expect(invalidComposite.stderr).toContain(
      '"$/.github/workflows/not-an-action.yml"',
    );
    expect(invalidComposite.stderr).not.toContain(
      '"actions/harmless-input@v4"',
    );
  });
});

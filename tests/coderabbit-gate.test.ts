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
  existingGateCheckIds?: number[];
  gateAppId?: number | null;
  gateAppSlug?: string | null;
  gateChecksError?: Error;
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

async function runPinVerifier(input?: string) {
  const command = ["ruby", "scripts/verify-workflow-pins.rb"];
  if (input !== undefined) command.push("--stdin", "fixture.yml");
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
  const notices: string[] = [];
  let checkGetCount = 0;
  let getRefCount = 0;
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
  ).map((id) => ({
    app: { id: gateAppId, slug: gateAppSlug },
    conclusion: "failure",
    external_id: "previous-reconciliation",
    head_sha: headSha,
    id,
    name: gateName,
    status: "completed",
  }));
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
                  options.mainChangesDuringEvaluation && getRefCount > 1
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
  await execute(github, context, core, { env });
  return { created, errors, failures, gateChecks, notices, updated };
}

async function runRoute(
  options: {
    actor?: string;
    canonicalId?: number;
    canonicalName?: string;
    canonicalPath?: string;
    collaboratorNotFound?: boolean;
    collaboratorPermission?: string;
    emptyPullRequests?: boolean;
    eventName?: "issue_comment" | "pull_request_target" | "workflow_run";
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
          : {
              workflow_run: {
                actor: { login: options.actor ?? "github-actions[bot]" },
                event: "pull_request_review",
                head_sha: options.headSha ?? headSha,
                path: options.runPath ?? reviewSignalPath,
                pull_requests: options.emptyPullRequests ? [] : [{ number: 7 }],
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
  };
  const execute = new AsyncFunction("github", "context", "core", script);
  await execute(github, context, core);
  return { failures, outputs };
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
    expect(await Bun.file(gatePath).text()).not.toContain("actions/checkout");
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

  test("gates the exact head using current-head CodeRabbit approval", async () => {
    const result = await runGate({
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });
    expect(result.failures).toEqual([]);
    expect(result.created[0]).toMatchObject({
      external_id: `alitycs-coderabbit-gate/v8:7:${headSha}:99:1`,
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

  test("reuses one app-owned exact-head check across reconciliations", async () => {
    const result = await runGate({
      existingGateCheckIds: [401],
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
      runId: 100,
    });

    expect(result.created).toEqual([]);
    expect(result.updated[0]).toMatchObject({
      check_run_id: 401,
      external_id: `alitycs-coderabbit-gate/v8:7:${headSha}:100:1`,
      status: "in_progress",
    });
    expect(result.updated.at(-1)).toMatchObject({
      check_run_id: 401,
      conclusion: "success",
      status: "completed",
    });
    expect(
      result.gateChecks.filter((checkRun) => checkRun.name === gateName),
    ).toHaveLength(1);
    expect(await loadGateScript()).toContain("listForRef");
  });

  test("normalizes duplicate app-owned checks before publishing success", async () => {
    const result = await runGate({
      existingGateCheckIds: [401, 402],
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });

    expect(result.created).toEqual([]);
    expect(
      result.gateChecks.filter((checkRun) => checkRun.name === gateName),
    ).toEqual([expect.objectContaining({ conclusion: "success", id: 401 })]);
    expect(result.gateChecks).toContainEqual(
      expect.objectContaining({
        conclusion: "neutral",
        id: 402,
        name: `${gateName} (superseded 402)`,
      }),
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
    for (const identity of [{ gateAppId: null }, { gateAppSlug: null }]) {
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

  test("limits live schema validation to policy-changing pull requests", async () => {
    const ci = await Bun.file(".github/workflows/ci.yml").text();
    const docs = await Bun.file("docs/coderabbit.md").text();
    expect(ci).toContain("Detect CodeRabbit configuration changes");
    expect(ci).toContain(
      "if: steps.coderabbit-config.outputs.changed == 'true'",
    );
    expect(ci).toContain("-- .coderabbit.yaml");
    expect(ci).toContain("./scripts/verify-workflow-pins.rb");
    expect(
      docs.match(/\.\/scripts\/validate-coderabbit\.sh/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  test("audits the synchronized commit and exact app allowlists", async () => {
    const audit = await Bun.file("scripts/audit-coderabbit-github.sh").text();

    expect(audit).toContain(
      'git show "${local_head}:scripts/verify-workflow-pins.rb"',
    );
    expect(audit).toContain('ruby - --git-ref "$local_head"');
    expect(audit).toContain(
      'readonly protected_workflow_tree=".github/workflows"',
    );
    expect(audit).toContain('.repository_selection == "selected"');
    expect(audit).toContain(".required_status_checks.checks | length == 3");
    expect(audit).toContain(".permissions == {");
    expect(audit).not.toContain(".permissions.checks ==");
    expect(audit).toContain("(.events // []) == []");
    expect(audit).toContain("(.events | sort) == ([");
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
  invalid:
    steps:
      - "uses" : actions/checkout@v4
      - { uses: actions/setup-node@v4 }
      - uses: docker://alpine:latest
      - *uses-key: *mutable-action
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        uses: actions/cache@v4
`);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain('"actions/checkout@v4"');
    expect(invalid.stderr).toContain('"actions/setup-node@v4"');
    expect(invalid.stderr).toContain('"docker://alpine:latest"');
    expect(invalid.stderr).toContain('"actions/cache@v4"');

    const valid = await runPinVerifier(`
jobs:
  valid:
    uses: alitycs/reusable/.github/workflows/ci.yml@${"a".repeat(40)}
  actions:
    steps:
      - "uses": actions/checkout@${"b".repeat(40)}
      - { uses: "docker://ghcr.io/alitycs/build@sha256:${"c".repeat(64)}" }
      - uses: ./local-action
`);
    expect(valid.exitCode).toBe(0);
  });
});

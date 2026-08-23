import { afterEach, describe, expect, test } from "bun:test";

interface ReviewFixture {
  commit_id: string;
  id: number;
  state: string;
  submitted_at: string;
  user: { login: string };
}

const headSha = "0123456789abcdef0123456789abcdef01234567";
const AsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as new (
  ...arguments_: string[]
) => (...arguments_: unknown[]) => Promise<void>;

async function loadWorkflow() {
  return Bun.YAML.parse(
    await Bun.file(".github/workflows/coderabbit-gate.yml").text(),
  ) as {
    jobs: {
      reconcile: {
        environment: string;
        steps: Array<{
          name: string;
          uses?: string;
          with?: { script?: string };
        }>;
      };
    };
    on: Record<string, unknown>;
    permissions: Record<string, string>;
  };
}

async function runGate(
  options: {
    author?: string;
    files?: Array<{ filename: string; previous_filename?: string }>;
    permission?: string;
    reviews?: ReviewFixture[];
  } = {},
) {
  const workflow = await loadWorkflow();
  const script = workflow.jobs.reconcile.steps.find(
    (step) => step.name === "Publish the current-head gate",
  )?.with?.script;
  if (!script) throw new Error("Gate script is missing");

  const listFiles = () => undefined;
  const listReviews = () => undefined;
  const listPullRequestsAssociatedWithCommit = () => undefined;
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  const github = {
    paginate: async (method: unknown) => {
      if (method === listFiles) return options.files ?? [];
      if (method === listReviews) return options.reviews ?? [];
      if (method === listPullRequestsAssociatedWithCommit) return [];
      throw new Error("Unexpected paginated endpoint");
    },
    rest: {
      checks: {
        create: async (input: Record<string, unknown>) => {
          created.push(input);
          return { data: { id: 501 } };
        },
        update: async (input: Record<string, unknown>) => {
          updated.push(input);
          return { data: input };
        },
      },
      pulls: {
        get: () => undefined,
        listFiles,
        listReviews,
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: options.permission ?? "write" },
        }),
        listPullRequestsAssociatedWithCommit,
      },
    },
  };
  const context = {
    actor: "maintainer",
    eventName: "pull_request_target",
    payload: {
      pull_request: {
        base: { ref: "main" },
        draft: false,
        head: { sha: headSha },
        number: 7,
        state: "open",
        user: { login: options.author ?? "maintainer" },
      },
    },
    repo: { owner: "alitycs", repo: "alitycs-sdk-js" },
    runAttempt: 1,
    runId: 99,
  };
  const core = {
    info: () => undefined,
    notice: () => undefined,
    setFailed: (message: string) => failures.push(message),
  };
  const immediateTimeout = (resolve: () => void) => resolve();
  const execute = new AsyncFunction(
    "github",
    "context",
    "core",
    "setTimeout",
    "process",
    script,
  );
  await execute(github, context, core, immediateTimeout, {
    env: { GATE_APP_SLUG: "alitycs-coderabbit-gate" },
  });
  return { created, failures, updated };
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

afterEach(() => {
  delete process.env.GATE_APP_SLUG;
});

describe("trusted CodeRabbit workflow", () => {
  test("runs from the trusted base and uses the restricted environment", async () => {
    const workflow = await loadWorkflow();
    expect(workflow.on.pull_request_target).toBeDefined();
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.pull_request_review).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.reconcile.environment).toBe("coderabbit-gate");
    expect(
      await Bun.file(".github/workflows/coderabbit-gate.yml").text(),
    ).not.toContain("actions/checkout");
  });

  test("publishes success on the exact head for current CodeRabbit approval", async () => {
    const result = await runGate({
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });
    expect(result.failures).toEqual([]);
    expect(result.created[0]).toMatchObject({
      head_sha: headSha,
      name: "Alitycs CodeRabbit Gate",
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

  test("rejects pull requests that modify the trusted gate", async () => {
    const result = await runGate({
      files: [{ filename: ".github/workflows/coderabbit-gate.yml" }],
      reviews: [
        review("coderabbitai[bot]", "APPROVED", "2026-08-23T12:00:00Z"),
      ],
    });
    expect(result.failures).toEqual([
      "The trusted gate workflow cannot be changed by an ordinary pull request. Use the documented two-phase gate upgrade procedure.",
    ]);
    expect(result.updated.at(-1)).toMatchObject({ conclusion: "failure" });
  });
});

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = process.cwd();
const pinVerifierPath = join(repositoryRoot, "scripts/verify-workflow-pins.rb");

async function runPinVerifier(input?: string, label = "fixture.yml") {
  const command = ["ruby", pinVerifierPath];
  if (input !== undefined) command.push("--stdin", label);
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
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

async function workflowCorpus() {
  const directory = ".github/workflows";
  const names = (await readdir(directory)).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  const texts = await Promise.all(
    names.map((name) => Bun.file(join(directory, name)).text()),
  );
  return { names, text: texts.join("\n"), texts };
}

describe("repository-owned CodeRabbit policy", () => {
  test("uses CodeRabbit's native fail-closed review lifecycle", async () => {
    const raw = await Bun.file(".coderabbit.yaml").text();
    const policy = Bun.YAML.parse(raw) as {
      reviews: {
        auto_review: {
          drafts: boolean;
          enabled: boolean;
          auto_incremental_review: boolean;
          ignore_usernames?: string[];
        };
        fail_commit_status: boolean;
        request_changes_workflow: boolean;
        review_progress: boolean;
        tools: { "github-checks": { enabled: boolean } };
      };
    };

    expect(policy.reviews.request_changes_workflow).toBe(true);
    expect(policy.reviews.review_progress).toBe(true);
    expect(policy.reviews.fail_commit_status).toBe(true);
    expect(policy.reviews.auto_review.enabled).toBe(true);
    expect(policy.reviews.auto_review.auto_incremental_review).toBe(true);
    expect(policy.reviews.auto_review.drafts).toBe(false);
    expect(policy.reviews.auto_review.ignore_usernames ?? []).toEqual([]);
    expect(policy.reviews.tools["github-checks"].enabled).toBe(true);
  });

  test("contains no custom Gate App or reconciliation machinery", async () => {
    for (const removedPath of [
      ".github/workflows/coderabbit-gate.yml",
      ".github/workflows/coderabbit-review-event.yml",
      "scripts/audit-coderabbit-github.sh",
    ]) {
      expect(await Bun.file(removedPath).exists()).toBe(false);
    }

    const workflows = await workflowCorpus();
    const corpus = [
      await Bun.file(".coderabbit.yaml").text(),
      await Bun.file("CONTRIBUTING.md").text(),
      await Bun.file("docs/coderabbit.md").text(),
      await Bun.file(".github/PULL_REQUEST_TEMPLATE.md").text(),
      workflows.text,
    ].join("\n");
    for (const forbidden of [
      "alitycs-coderabbit-gate",
      "ALITYCS_CODERABBIT_GATE",
      "Alitycs CodeRabbit Gate",
      "/coderabbit-gate",
      "coderabbit-gate.yml",
      "coderabbit-review-event.yml",
    ]) {
      expect(corpus).not.toContain(forbidden);
    }
  });

  test("protects policy and automation through CODEOWNERS", async () => {
    const codeowners = await Bun.file(".github/CODEOWNERS").text();
    for (const protectedPath of [
      "/.coderabbit.yaml @bulanovdm",
      "/.github/ @bulanovdm",
      "/scripts/coderabbit-schema.v2.json @bulanovdm",
      "/scripts/coderabbit-validator-requirements.txt @bulanovdm",
      "/scripts/validate-coderabbit.sh @bulanovdm",
      "/scripts/verify-workflow-pins.rb @bulanovdm",
      "/docs/coderabbit.md @bulanovdm",
      "/CONTRIBUTING.md @bulanovdm",
    ]) {
      expect(codeowners).toContain(protectedPath);
    }
  });

  test("validates pinned CodeRabbit inputs without gating on live schema availability", async () => {
    const ci = await Bun.file(".github/workflows/ci.yml").text();
    const drift = await Bun.file(
      ".github/workflows/coderabbit-schema-drift.yml",
    ).text();
    const validator = await Bun.file("scripts/validate-coderabbit.sh").text();
    const requirements = await Bun.file(
      "scripts/coderabbit-validator-requirements.txt",
    ).text();

    expect(ci).toContain("Detect CodeRabbit validation input changes");
    expect(ci).toContain("./scripts/validate-coderabbit.sh");
    for (const validationPath of [
      ".coderabbit.yaml",
      "scripts/coderabbit-schema.v2.json",
      "scripts/coderabbit-validator-requirements.txt",
      "scripts/validate-coderabbit.sh",
    ]) {
      expect(ci).toContain(`"${validationPath}"`);
    }
    expect(validator).toContain("--require-hashes");
    expect(validator).not.toContain("https://coderabbit.ai");
    expect(requirements).toContain("check-jsonschema==0.37.4");
    expect(requirements).toContain("--hash=sha256:");
    expect(drift).toMatch(/^  schedule:$/m);
    expect(drift).toMatch(/^  workflow_dispatch:$/m);
    expect(drift).not.toMatch(/^  pull_request(?:_target)?:$/m);
    expect(drift).not.toMatch(/^  push:$/m);
    expect(drift).toContain(
      "https://coderabbit.ai/integrations/schema.v2.json",
    );
  });

  test("enforces immutable actions, runners, and workflow images", async () => {
    const current = await runPinVerifier();
    expect(current.exitCode).toBe(0);
    expect(current.stdout).toContain("immutable third-party");

    const immutableAction = `actions/checkout@${"a".repeat(40)}`;
    const cases = [
      {
        input: `jobs:\n  invalid:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n`,
        message: '"actions/checkout@v4"',
      },
      {
        input: `jobs:\n  invalid:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${immutableAction}\n`,
        message: 'got "ubuntu-latest"',
      },
      {
        input: `jobs:\n  invalid:\n    runs-on: ubuntu-24.04\n    container: alpine:latest\n    steps:\n      - uses: ${immutableAction}\n`,
        message: 'got "alpine:latest"',
      },
      {
        input: `defaults: &defaults { runs-on: ubuntu-24.04 }\njobs:\n  invalid:\n    <<: *defaults\n`,
        message: "YAML merge keys (<<) are not supported",
      },
    ];
    for (const fixture of cases) {
      const result = await runPinVerifier(fixture.input);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(fixture.message);
    }

    const workflows = await workflowCorpus();
    expect(workflows.names.length).toBeGreaterThan(0);
    expect(workflows.text).not.toContain("ubuntu-latest");
    for (const text of workflows.texts) {
      const parsed = Bun.YAML.parse(text) as {
        jobs?: Record<string, { "runs-on"?: unknown; uses?: unknown }>;
      };
      for (const job of Object.values(parsed.jobs ?? {})) {
        if (job.uses === undefined) expect(job["runs-on"]).toBe("ubuntu-24.04");
      }
    }
  });

  test("keeps release publication isolated and tied to reviewed main history", async () => {
    const text = await Bun.file(".github/workflows/release.yml").text();
    const workflow = Bun.YAML.parse(text) as {
      permissions: Record<string, string>;
      jobs: {
        build: { permissions: Record<string, string> };
        release: { needs: string; permissions: Record<string, string> };
      };
    };

    expect(workflow.permissions).toEqual({});
    expect("concurrency" in workflow).toBe(false);
    expect(workflow.jobs.build.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.release.needs).toBe("build");
    expect(workflow.jobs.release.permissions).toEqual({
      attestations: "write",
      contents: "write",
      "id-token": "write",
    });
    expect(text).toContain("persist-credentials: false");
    expect(text).toContain(
      'git merge-base --is-ancestor "$tag_commit" "$main_commit"',
    );
    expect(text).toContain("Recheck immutable release tag");
  });
});

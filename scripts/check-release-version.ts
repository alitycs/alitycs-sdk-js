import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(
    `Expected a semantic version tag, received ${tag ?? "nothing"}`,
  );
}

const expectedVersion = tag.slice(1);
const manifests = [
  "sdks/core/package.json",
  "sdks/browser/package.json",
  "sdks/browser-snippet/package.json",
];

for (const manifest of manifests) {
  const path = resolve(import.meta.dir, "..", manifest);
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    name?: string;
    version?: string;
  };
  if (parsed.version !== expectedVersion) {
    throw new Error(
      `${parsed.name ?? manifest} is ${parsed.version ?? "unversioned"}; expected ${expectedVersion}`,
    );
  }
}

console.log(`Release tag ${tag} matches all package versions.`);

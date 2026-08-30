import { init } from "@alitycs/browser";
import { UTM_KEYS } from "@alitycs/core";

if (!Array.isArray(UTM_KEYS) || !UTM_KEYS.includes("utmSource")) {
  throw new Error("@alitycs/core lost its public UTM_KEYS export");
}

const instance = init({
  apiKey: "pk_smoke_test_0000000000000000000000000000",
  endpoint: "https://api.example.test/events",
});
if (typeof instance.shutdown !== "function") {
  throw new Error("@alitycs/browser did not initialize");
}
await instance.shutdown();

const snippetSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(
    new URL(
      "./node_modules/@alitycs/browser-snippet/dist/snippet.min.js",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (
  !snippetSource.includes(
    "https://cdn.jsdelivr.net/npm/@alitycs/browser@1.0.3/dist/browser.min.js",
  )
) {
  throw new Error("Snippet bundle lost its pinned CDN URL");
}
console.log("install smoke OK");

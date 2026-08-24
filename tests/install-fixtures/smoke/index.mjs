import { init } from "@alitycs/browser";

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
      "../../../release/@alitycs-browser-snippet-1.0.2/package/dist/snippet.min.js",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (!snippetSource.includes("cdn.jsdelivr.net/npm/@alitycs/browser@1.0.2")) {
  throw new Error("Snippet bundle lost its pinned CDN URL");
}
console.log("install smoke OK");

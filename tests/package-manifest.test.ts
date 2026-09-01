import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("published package manifest", () => {
  it("uses the Harness-owned Schemastery runtime", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(manifest.version).toBe("0.3.6");
    expect(manifest.dependencies?.["@deepseek-ai/schemastery"]).toBeUndefined();
    expect(manifest.optionalDependencies?.["@deepseek-ai/schemastery"]).toBeUndefined();
    expect(manifest.peerDependencies?.["@deepseek-ai/schemastery"]).toBe("*");
    expect(manifest.peerDependenciesMeta?.["@deepseek-ai/schemastery"]).toEqual({ optional: true });
    expect(manifest.devDependencies?.["@deepseek-ai/schemastery"]).toBe("3.18.2");
  });
});

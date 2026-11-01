import { describe, expect, it } from "vitest";
import { githubBlobUrl } from "./github";

const SHA = "0123abcd";
const BLOB = `https://github.com/acme/widgets/blob/${SHA}/src/a.ts`;

describe("githubBlobUrl", () => {
  it.each([
    "git@github.com:acme/widgets.git",
    "git@github.com:acme/widgets",
    "ssh://git@github.com/acme/widgets.git",
    "ssh://git@github.com/acme/widgets",
    "https://github.com/acme/widgets.git",
    "https://github.com/acme/widgets",
  ])("links %s", (remote) => {
    expect(githubBlobUrl(remote, SHA, "src/a.ts", 3, 9)).toBe(`${BLOB}#L3-L9`);
  });

  it("is null for other hosts", () => {
    expect(githubBlobUrl("git@gitlab.com:acme/widgets.git", SHA, "src/a.ts", 3, 9)).toBeNull();
    expect(githubBlobUrl("https://git.example.com/acme/widgets", SHA, "src/a.ts", 3, 9)).toBeNull();
  });

  it("is null without a sha, remote or path", () => {
    expect(githubBlobUrl("git@github.com:acme/widgets.git", null, "src/a.ts", 3, 9)).toBeNull();
    expect(githubBlobUrl(null, SHA, "src/a.ts", 3, 9)).toBeNull();
    expect(githubBlobUrl("git@github.com:acme/widgets.git", SHA, null, 3, 9)).toBeNull();
  });

  it("uses a single line when there's no end or it equals the start", () => {
    expect(githubBlobUrl("git@github.com:acme/widgets.git", SHA, "src/a.ts", 3, null)).toBe(`${BLOB}#L3`);
    expect(githubBlobUrl("git@github.com:acme/widgets.git", SHA, "src/a.ts", 3, 3)).toBe(`${BLOB}#L3`);
    expect(githubBlobUrl("git@github.com:acme/widgets.git", SHA, "src/a.ts")).toBe(BLOB);
  });
});

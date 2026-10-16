import { describe, expect, it } from "vitest";
import { commitsFromGitLog, parseGitLog, visibleNodeIdsAt } from "@/lib/engines/story";
import { authMicroservice } from "@/lib/mockData";

const LOG = [
  "commit 9c02e5a1111111111111111111111111111111",
  "Author: Dev Okafor <dev@example.com>",
  "Date:   2026-05-07",
  "",
  "    perf(auth): Redis revocation list",
  "",
  "A\tsrc/server/cache/sessions.ts",
  "M\tsrc/server/auth/jwt.ts",
  "",
  "commit a1f3c092222222222222222222222222222222",
  "Author: Maria K <maria@example.com>",
  "Date:   2026-03-02",
  "",
  "    feat(auth): bootstrap users table",
  "",
  "A\tsrc/server/db/users.ts",
  "R100\tsrc/old.ts\tsrc/server/auth/controller.ts",
].join("\n");

describe("parseGitLog", () => {
  it("parses default git log output oldest-first with short hashes", () => {
    const commits = parseGitLog(LOG);
    expect(commits.map((c) => c.hash)).toEqual(["a1f3c09", "9c02e5a"]);
    expect(commits[0]).toMatchObject({ author: "Maria K", message: "feat(auth): bootstrap users table" });
    expect(commits[0]!.files[1]).toEqual({ status: "R", path: "src/server/auth/controller.ts" });
  });

  it("parses --oneline output", () => {
    const commits = parseGitLog("abc1234 fix: thing\nM\tsrc/a.ts\ndef5678 feat: other\n");
    expect(commits.map((c) => c.message)).toEqual(["feat: other", "fix: thing"]);
  });
});

describe("commitsFromGitLog", () => {
  it("maps changed files onto graph nodes", () => {
    const commits = commitsFromGitLog(LOG, authMicroservice.nodes);
    expect(commits[0]).toMatchObject({ addedNodeIds: ["users-db"], modifiedNodeIds: ["auth-controller"] });
    expect(commits[1]).toMatchObject({ addedNodeIds: ["session-cache"], modifiedNodeIds: ["jwt-service"] });
  });

  it("rejects text with no commits", () => {
    expect(() => commitsFromGitLog("hello", authMicroservice.nodes)).toThrow(/No commits found/);
  });
});

describe("visibleNodeIdsAt", () => {
  it("shows only nodes introduced up to the frame", () => {
    const visible = visibleNodeIdsAt(authMicroservice.nodes, authMicroservice.commits, 0);
    expect([...visible].sort()).toEqual(["auth-controller", "users-db"]);
    expect(visibleNodeIdsAt(authMicroservice.nodes, authMicroservice.commits, 3).size).toBe(6);
  });
});

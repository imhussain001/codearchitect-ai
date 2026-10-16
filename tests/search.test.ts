import { describe, expect, it } from "vitest";
import { searchNodes } from "@/lib/search";
import { authMicroservice, ecommerceApi } from "@/lib/mockData";

const ids = (query: string, graph = authMicroservice) => searchNodes(graph.nodes, query).map((h) => h.nodeId);

describe("searchNodes", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
  });

  it("matches by component name, case-insensitively, best first", () => {
    expect(ids("JWT")[0]).toBe("jwt-service");
    expect(ids("users database")[0]).toBe("users-db");
  });

  it("ranks an exact name above a partial one", () => {
    const hits = searchNodes(authMicroservice.nodes, "Auth Controller");
    expect(hits[0]!.nodeId).toBe("auth-controller");
  });

  it("requires every word to match (AND)", () => {
    // Auth Controller's description mentions the JWT service, so it matches too, but ranks below the JWT service itself.
    expect(ids("auth jwt")).toEqual(["jwt-service", "auth-controller"]);
    expect(ids("dashboard jwt")).toEqual([]);
    expect(ids("zzz")).toEqual([]);
  });

  it("matches file paths, exported symbols and keywords", () => {
    expect(searchNodes(authMicroservice.nodes, "server/db")[0]).toMatchObject({ nodeId: "users-db", matchedOn: "path" });
    expect(searchNodes(authMicroservice.nodes, "usersRepo")[0]).toMatchObject({ nodeId: "users-db", matchedOn: "export" });
    expect(ids("redis")).toContain("session-cache");
  });

  it("finds components by word inside a camelCase export", () => {
    expect(ids("stripe", ecommerceApi)[0]).toBe("payment-adapter");
  });

  it("honours the result limit", () => {
    expect(searchNodes(authMicroservice.nodes, "a", 2)).toHaveLength(2);
  });
});

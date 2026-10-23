import { describe, expect, it } from "vitest";
import { buildHeuristicGraph, isAnalyzableSource } from "@/lib/engines/heuristicGraph";
import { csExports, csTypes, csUsings } from "@/lib/engines/csharpImports";
import { analyzeHealth } from "@/lib/engines/health";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";

describe("C# parsing", () => {
  it("finds top-level types with their namespace, for block and file-scoped namespaces", () => {
    const block = `using System;\nnamespace Acme.Auth\n{\n    public class JwtService\n    {\n        private class Hidden {}\n    }\n    internal interface IClock {}\n}\n`;
    expect(csTypes(block)).toEqual([
      { name: "JwtService", namespace: "Acme.Auth", isPublic: true },
      { name: "IClock", namespace: "Acme.Auth", isPublic: true },
    ]);
    const scoped = `namespace Acme.Web;\n\npublic record UserDto(string Id);\npublic enum Role { Admin }\npublic delegate void Handler(int x);\n`;
    expect(csTypes(scoped).map((t) => [t.name, t.namespace])).toEqual([["UserDto", "Acme.Web"], ["Role", "Acme.Web"], ["Handler", "Acme.Web"]]);
  });

  it("joins nested namespace blocks and handles types with no namespace", () => {
    expect(csTypes(`namespace A { namespace B { class X {} } class Y {} }`).map((t) => `${t.namespace}.${t.name}`).sort()).toEqual(["A.B.X", "A.Y"]);
    expect(csTypes(`class Global {}`)).toEqual([{ name: "Global", namespace: "", isPublic: true }]);
  });

  it("ignores types in comments and strings, and nested types", () => {
    const src = `namespace N { // class Fake {}\n  /* struct AlsoFake {} */\n  public class Real { string s = "class InString {}"; public class Nested {} }\n}`;
    expect(csTypes(src).map((t) => t.name)).toEqual(["Real"]);
    expect(csExports(src)).toEqual(["Real"]);
  });

  it("reads using directives: plain, static, alias and global", () => {
    const src = `global using System.Linq;\nusing System;\nusing static Acme.Util.Strings;\nusing Json = Newtonsoft.Json.JsonConvert;\nusing var x = Make();\nclass C {}\n`;
    expect(csUsings(src)).toEqual([
      { namespace: "System.Linq", isStatic: false, isGlobal: true },
      { namespace: "System", isStatic: false, isGlobal: false },
      { namespace: "Acme.Util.Strings", isStatic: true, isGlobal: false },
      { namespace: "Newtonsoft.Json.JsonConvert", isStatic: false, isGlobal: false, alias: "Json" },
    ]);
  });

  it("copes with verbatim, interpolated and raw strings", () => {
    const src = `namespace N {\n  public class A {\n    string v = @"c:\\temp\\""quoted"" class Nope {}";\n    string i = $"hello {name} class AlsoNope {}";\n    string r = """\n      class RawNope {}\n      """;\n  }\n}`;
    expect(csTypes(src).map((t) => t.name)).toEqual(["A"]);
  });
});

describe("file filtering", () => {
  it("skips build output, generated code, assembly info and test projects, but not look-alike names", () => {
    for (const p of ["obj/Debug/net8.0/App.AssemblyInfo.cs", "src/App/bin/Release/x.cs", "src/Views/Main.Designer.cs", "src/Models/Thing.g.cs", "src/Properties/AssemblyInfo.cs", "src/App.Tests/FooTests.cs", "src/Foo/UserServiceTests.cs"]) expect(isAnalyzableSource(p), p).toBe(false);
    for (const p of ["src/Services/Contest.cs", "src/Domain/Latest.cs", "src/App/Program.cs", "src/Tools/bin/Run.rs"]) expect(isAnalyzableSource(p), p).toBe(true);
  });
});

const files = [
  { path: "src/Program.cs", content: `using Acme.Web;\nusing Acme.Services;\n\nvar controller = new UsersController(new UserService());\nSystem.Console.WriteLine(controller);\n` },
  { path: "src/Web/UsersController.cs", content: `using Acme.Services;\nusing Acme.Data;\nnamespace Acme.Web;\n\npublic class UsersController\n{\n    private readonly UserService _service;\n    public UsersController(UserService service) { _service = service; }\n    public User Find(string id) => _service.Find(id);\n}\n` },
  { path: "src/Services/UserService.cs", content: `using Acme.Data;\nusing Microsoft.Extensions.Logging;\nnamespace Acme.Services\n{\n    public class UserService\n    {\n        private readonly UserRepository _repo = new UserRepository();\n        public User Find(string id) => _repo.ById(id);\n        public Helper H => new Helper();\n    }\n    internal class Helper {}\n}\n` },
  { path: "src/Data/UserRepository.cs", content: `namespace Acme.Data;\n\npublic class UserRepository\n{\n    public User ById(string id) => new User(id);\n}\n` },
  { path: "src/Data/User.cs", content: `namespace Acme.Data;\n\npublic record User(string Id);\n` },
  { path: "src/Data/Audit.cs", content: `namespace Acme.Data;\n\ninternal class Audit\n{\n    public User Who { get; set; }\n}\n` },
  { path: "src/Util/Strings.cs", content: `namespace Acme.Util;\n\npublic static class Strings\n{\n    public static string Slug(string s) => s;\n}\n` },
  { path: "src/Services/Report.cs", content: `using static Acme.Util.Strings;\nusing S = Acme.Util.Strings;\nnamespace Acme.Services;\n\npublic class Report\n{\n    public string Name() => Slug("x") + S.Slug("y") + Acme.Data.User.Empty;\n}\n` },
];
const graph = buildHeuristicGraph("acme", files);
const idOf = (suffix: string) => graph.nodes.find((n) => n.data.filePath.endsWith(suffix))!.id;
const edge = (from: string, to: string) => graph.edges.find((e) => e.source === idOf(from) && e.target === idOf(to));

describe("C# edges", () => {
  it("links a using-imported namespace's types that are actually mentioned", () => {
    expect(edge("Program.cs", "UsersController.cs")?.symbols).toEqual(["UsersController"]);
    expect(edge("Program.cs", "UserService.cs")?.symbols).toEqual(["UserService"]);
    expect(edge("UsersController.cs", "UserService.cs")?.symbols).toEqual(["UserService"]);
    expect(edge("UsersController.cs", "User.cs")?.symbols).toEqual(["User"]);
  });

  it("does not link a namespace's types that the file never mentions", () => {
    expect(edge("UsersController.cs", "UserRepository.cs")).toBeUndefined();
    expect(edge("UsersController.cs", "Audit.cs")).toBeUndefined();
    expect(edge("Program.cs", "User.cs")).toBeUndefined(); // Program imports Acme.Web and Acme.Services only
  });

  it("is a real dependency when it goes through a using, and samePackage inside one namespace", () => {
    expect(edge("UserService.cs", "UserRepository.cs")?.samePackage).toBeUndefined();
    expect(edge("Audit.cs", "User.cs")?.samePackage).toBe(true);
    expect(edge("Audit.cs", "User.cs")?.symbols).toEqual(["User"]);
  });

  it("follows using static, alias and fully written-out names", () => {
    expect(edge("Report.cs", "Strings.cs")?.symbols).toEqual(["Strings"]);
    expect(edge("Report.cs", "User.cs")?.symbols).toEqual(["User"]);
  });

  it("ignores the framework and packages", () => {
    expect(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.target))).toBe(true);
    expect(graph.edges.some((e) => graph.nodes.find((n) => n.id === e.target)!.data.filePath.includes("Microsoft"))).toBe(false);
  });

  it("treats Program.cs and controllers as entry points, not orphans", () => {
    const orphans = analyzeHealth(graph).issues.filter((i) => i.kind === "orphan").flatMap((i) => i.nodeIds);
    expect(orphans).not.toContain(idOf("Program.cs"));
    expect(orphans).not.toContain(idOf("UsersController.cs"));
  });

  it("classifies by .NET naming: controllers are API, repositories and contexts are data", () => {
    expect(graph.nodes.find((n) => n.data.filePath.endsWith("UsersController.cs"))!.data.kind).toBe("api");
    expect(graph.nodes.find((n) => n.data.filePath.endsWith("UserRepository.cs"))!.data.kind).toBe("data");
  });

  it("does not report loops inside one namespace as cycles", () => {
    const g = buildHeuristicGraph("l", [
      { path: "A.cs", content: `namespace N;\npublic class A { B b; }\n` },
      { path: "B.cs", content: `namespace N;\npublic class B { A a; }\n` },
    ]);
    expect(g.edges).toHaveLength(2);
    expect(analyzeHealth(g).issues.filter((i) => i.kind === "cycle")).toEqual([]);
  });

  it("narrows blast radius to the files that mention the type", () => {
    const result = analyzeImpactLocally(graph, "change UserRepository", idOf("UserRepository.cs"));
    const touched = result.impacts.map((i) => graph.nodes.find((n) => n.id === i.nodeId)!.data.filePath.split("/").pop()).sort();
    expect(touched).toEqual(expect.arrayContaining(["UserRepository.cs", "UserService.cs"]));
    expect(touched).not.toContain("Strings.cs");
  });
});

describe("C# special cases", () => {
  it("applies a global using to every file", () => {
    const g = buildHeuristicGraph("g", [
      { path: "GlobalUsings.cs", content: `global using Acme.Common;\n` },
      { path: "src/Common/Result.cs", content: `namespace Acme.Common;\npublic class Result {}\n` },
      { path: "src/App/Run.cs", content: `namespace Acme.App;\npublic class Run { Result r; }\n` },
    ]);
    const e = g.edges.find((x) => g.nodes.find((n) => n.id === x.source)!.data.filePath === "src/App/Run.cs");
    expect(g.nodes.find((n) => n.id === e!.target)!.data.filePath).toBe("src/Common/Result.cs");
  });

  it("links to every part of a partial class", () => {
    const g = buildHeuristicGraph("p", [
      { path: "src/Order.cs", content: `namespace Acme.Model;\npublic partial class Order {}\n` },
      { path: "src/Order.Pricing.cs", content: `namespace Acme.Model;\npublic partial class Order { decimal Total() => 0; }\n` },
      { path: "src/Use.cs", content: `using Acme.Model;\nnamespace Acme.App;\nclass U { Order o; }\n` },
    ]);
    const from = g.nodes.find((n) => n.data.filePath === "src/Use.cs")!.id;
    expect(g.edges.filter((e) => e.source === from)).toHaveLength(2);
  });

  it("prefers the nearest namespace when a name exists in two visible ones", () => {
    const g = buildHeuristicGraph("n", [
      { path: "src/A/Item.cs", content: `namespace Acme.A;\npublic class Item {}\n` },
      { path: "src/B/Item.cs", content: `namespace Acme.B;\npublic class Item {}\n` },
      { path: "src/B/Use.cs", content: `using Acme.A;\nnamespace Acme.B;\npublic class Use { Item i; }\n` },
    ]);
    const from = g.nodes.find((n) => n.data.filePath === "src/B/Use.cs")!.id;
    const targets = g.edges.filter((e) => e.source === from).map((e) => g.nodes.find((n) => n.id === e.target)!.data.filePath);
    expect(targets).toEqual(["src/B/Item.cs"]);
  });
});

describe("extension methods and project hygiene", () => {
  it("links a file that calls an extension method to the static class that declares it", () => {
    const g = buildHeuristicGraph("x", [
      { path: "src/Internal/StringExtensions.cs", content: `namespace Acme.Internal;\ninternal static class StringExtensions\n{\n    public static string Slug(this string s) => s;\n    public static T Cast<T>(this object o) => (T)o;\n}\n` },
      { path: "src/App/Use.cs", content: `using Acme.Internal;\nnamespace Acme.App;\npublic class Use { string F(string n) => n.Slug(); }\n` },
      { path: "src/App/NoUse.cs", content: `namespace Acme.App;\npublic class NoUse { string F(string n) => n.Slug(); }\n` }, // namespace not visible
    ]);
    const to = g.nodes.find((n) => n.data.filePath.endsWith("StringExtensions.cs"))!.id;
    const sources = g.edges.filter((e) => e.target === to).map((e) => g.nodes.find((n) => n.id === e.source)!.data.filePath);
    expect(sources).toEqual(["src/App/Use.cs"]);
    expect(g.edges[0]!.symbols).toEqual(["StringExtensions"]);
  });

  it("does not link an ordinary method call to a class that merely has a method of that name", () => {
    const g = buildHeuristicGraph("x", [
      { path: "src/Util.cs", content: `namespace Acme;\npublic static class Util { public static string Slug(string s) => s; }\n` }, // not an extension method
      { path: "src/Use.cs", content: `namespace Acme;\npublic class Use { string F(string n) => n.Slug(); }\n` },
    ]);
    expect(g.edges).toEqual([]);
  });

  it("skips test projects with dotted names and every AssemblyInfo variant", () => {
    for (const p of ["FluentValidation.Tests.Benchmarks/Program.cs", "src/Foo.Tests/Bar.cs", "src/AssemblyInfo.Foo.cs", "src/CommonAssemblyInfo.cs"]) expect(isAnalyzableSource(p), p).toBe(false);
    expect(isAnalyzableSource("src/FluentValidation/Validators/Latest.cs")).toBe(true);
  });
});

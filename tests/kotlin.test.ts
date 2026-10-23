import { describe, expect, it } from "vitest";
import { buildHeuristicGraph, isAnalyzableSource } from "@/lib/engines/heuristicGraph";
import { ktDeclarations, ktExports, ktImports, ktPackage } from "@/lib/engines/kotlinImports";

describe("Kotlin parsing", () => {
  it("reads the package and imports (plain, wildcard, alias), ignoring comments and strings", () => {
    const src = `// package fake.one\npackage com.acme.web\n\nimport com.acme.data.User\nimport com.acme.util.*\nimport com.acme.util.slugify as slug\n/* import nope.Nope */\nval s = "\\nimport also.Nope"\n`;
    expect(ktPackage(src)).toBe("com.acme.web");
    expect(ktImports(src)).toEqual([
      { name: "com.acme.data.User", wildcard: false },
      { name: "com.acme.util", wildcard: true },
      { name: "com.acme.util.slugify", wildcard: false, alias: "slug" },
    ]);
  });

  it("finds top-level classes, objects, interfaces, functions and properties, but nothing nested", () => {
    const src = `package p
data class User(val id: String)
sealed interface Event { class Created : Event }
fun interface Handler { fun handle() }
object Registry { fun register() {} }
typealias Id = String
@JvmOverloads fun slugify(s: String): String { val local = 1; return s }
private fun hidden() {}
internal suspend fun <T> List<T>.second(): T = this[1]
const val MAX = 3
private val secret = 1
class Outer { fun method() {} val field = 1 }
`;
    const decls = ktDeclarations(src).map((d) => `${d.kind}:${d.name}${d.isPublic ? "" : "!"}`);
    expect(decls).toEqual(expect.arrayContaining(["type:User", "type:Event", "type:Handler", "type:Registry", "type:Id", "type:Outer", "function:slugify", "function:hidden!", "function:second", "property:MAX", "property:secret!"]));
    for (const nested of ["Created", "handle", "register", "local", "method", "field", "interface"]) expect(decls.some((d) => d.endsWith(`:${nested}`)), nested).toBe(false);
    expect(ktExports(src)).not.toContain("hidden");
    expect(ktExports(src)).toContain("slugify");
  });

  it("copes with nested block comments, raw strings and char literals", () => {
    const src = `/* outer /* inner class Fake */ still comment class Fake2 */\nval raw = """\nclass RawNope\n"""\nval c = '{'\nclass Real\n`;
    expect(ktDeclarations(src).filter((d) => d.kind === "type").map((d) => d.name)).toEqual(["Real"]);
  });
});

describe("file filtering", () => {
  it("skips test sources, but not look-alike names", () => {
    for (const p of ["src/test/kotlin/FooTest.kt", "app/src/androidTest/java/X.kt", "lib/src/jvmTest/kotlin/A.kt", "src/main/kotlin/UserServiceTest.kt"]) expect(isAnalyzableSource(p), p).toBe(false);
    for (const p of ["src/main/kotlin/Contest.kt", "src/main/kotlin/Latest.kt", "src/main/kotlin/App.kt"]) expect(isAnalyzableSource(p), p).toBe(true);
  });
});

const files = [
  { path: "src/main/kotlin/App.kt", content: `package com.acme\n\nimport com.acme.web.UsersController\nimport com.acme.service.*\n\nfun main() {\n    val c = UsersController(UserService())\n    println(c)\n}\n` },
  { path: "src/main/kotlin/web/UsersController.kt", content: `package com.acme.web\n\nimport com.acme.service.UserService\nimport com.acme.data.User\nimport com.acme.util.slugify as slug\n\nclass UsersController(private val service: UserService) {\n    fun find(id: String): User = service.find(slug(id))\n}\n` },
  { path: "src/main/kotlin/service/UserService.kt", content: `package com.acme.service\n\nimport com.acme.data.UserRepository\nimport com.acme.data.User\n\nclass UserService {\n    private val repo = UserRepository()\n    fun find(id: String): User = repo.byId(id)\n}\nclass Unused\n` },
  { path: "src/main/kotlin/data/UserRepository.kt", content: `package com.acme.data\n\nclass UserRepository {\n    fun byId(id: String) = User(id)\n    fun audit() = Audit()\n}\n` },
  { path: "src/main/kotlin/data/User.kt", content: `package com.acme.data\n\ndata class User(val id: String)\n` },
  { path: "src/main/kotlin/data/Audit.kt", content: `package com.acme.data\n\ninternal class Audit\n` },
  { path: "src/main/kotlin/util/Strings.kt", content: `package com.acme.util\n\nfun slugify(s: String): String = s.lowercase()\nfun String.shout() = uppercase()\n` },
  { path: "src/main/kotlin/util/More.kt", content: `package com.acme.util\n\nfun more(s: String) = s.shout()\n` },
  { path: "src/main/java/com/acme/legacy/Legacy.java", content: `package com.acme.legacy;\npublic class Legacy {}\n` },
  { path: "src/main/kotlin/Bridge.kt", content: `package com.acme.bridge\n\nimport com.acme.legacy.Legacy\n\nfun bridge() = Legacy()\n` },
];
const graph = buildHeuristicGraph("acme", files);
const idOf = (suffix: string) => graph.nodes.find((n) => n.data.filePath.endsWith(suffix))!.id;
const edge = (from: string, to: string) => graph.edges.find((e) => e.source === idOf(from) && e.target === idOf(to));

describe("Kotlin edges", () => {
  it("links an explicit import to the file declaring the class", () => {
    expect(edge("App.kt", "UsersController.kt")?.symbols).toEqual(["UsersController"]);
    expect(edge("UsersController.kt", "UserService.kt")?.symbols).toEqual(["UserService"]);
    expect(edge("UserService.kt", "UserRepository.kt")?.symbols).toEqual(["UserRepository"]);
  });

  it("links a wildcard import only to files whose declarations are mentioned", () => {
    expect(edge("App.kt", "UserService.kt")?.symbols).toEqual(["UserService"]);
    expect(edge("App.kt", "Audit.kt")).toBeUndefined();
  });

  it("links an imported top-level function, even under an alias", () => {
    expect(edge("UsersController.kt", "Strings.kt")?.symbols).toEqual(["slugify"]);
  });

  it("links by mention inside one package and marks it samePackage", () => {
    const e = edge("UserRepository.kt", "Audit.kt");
    expect(e?.samePackage).toBe(true);
    expect(e?.symbols).toEqual(["Audit"]);
    expect(edge("UserRepository.kt", "User.kt")?.samePackage).toBe(true);
    expect(edge("More.kt", "Strings.kt")?.symbols).toEqual(["shout"]);
  });

  it("an explicit import is not samePackage", () => {
    expect(edge("UserService.kt", "UserRepository.kt")?.samePackage).toBeUndefined();
  });

  it("does not link files that are never mentioned", () => {
    expect(edge("UserService.kt", "Audit.kt")).toBeUndefined();
    expect(edge("App.kt", "User.kt")).toBeUndefined();
  });

  it("resolves Java classes imported from Kotlin", () => {
    expect(edge("Bridge.kt", "Legacy.java")?.symbols).toEqual(["Legacy"]);
  });

  it("has no self edges", () => {
    expect(graph.edges.filter((e) => e.source === e.target)).toEqual([]);
  });
});

describe("Kotlin Multiplatform", () => {
  const kmp = buildHeuristicGraph("kmp", [
    { path: "core/src/commonMain/kotlin/org/k/Platform.kt", content: `package org.k\n\nexpect object Platform { fun name(): String }\n` },
    { path: "core/src/jvmMain/kotlin/org/k/Platform.jvm.kt", content: `package org.k\n\nactual object Platform { actual fun name() = "jvm" }\n` },
    { path: "core/src/jsMain/kotlin/org/k/Platform.js.kt", content: `package org.k\n\nactual object Platform { actual fun name() = "js" }\n` },
    { path: "app/src/commonMain/kotlin/org/app/Main.kt", content: `package org.app\n\nimport org.k.Platform\n\nfun main() = println(Platform.name())\n` },
  ]);
  it("links an import to the common declaration, not to every platform actual", () => {
    const main = kmp.nodes.find((n) => n.data.filePath.endsWith("Main.kt"))!.id;
    const targets = kmp.edges.filter((e) => e.source === main).map((e) => kmp.nodes.find((n) => n.id === e.target)!.data.filePath);
    expect(targets).toEqual(["core/src/commonMain/kotlin/org/k/Platform.kt"]);
  });
});

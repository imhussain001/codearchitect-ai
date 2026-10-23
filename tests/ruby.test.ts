import { describe, expect, it } from "vitest";
import { buildHeuristicGraph, classifyPath, isAnalyzableSource } from "@/lib/engines/heuristicGraph";
import { rubyDeclarations, rubyRequires } from "@/lib/engines/rubyImports";

describe("Ruby parsing", () => {
  it("reads require, require_relative and autoload, ignoring comments, heredocs and strings", () => {
    const src = `# require 'fake'\nrequire 'json'\nrequire_relative "util/strings"\nrequire("set")\nautoload :Parser, 'acme/parser'\nx = <<~EOS\n  require 'inside_heredoc'\nEOS\nputs "require 'in_string'"\n=begin\nrequire 'in_block_comment'\n=end\n`;
    expect(rubyRequires(src)).toEqual([
      { kind: "require", target: "json" },
      { kind: "relative", target: "util/strings" },
      { kind: "require", target: "set" },
      { kind: "autoload", target: "acme/parser" },
    ]);
  });

  it("qualifies declarations from indentation and compact names", () => {
    const src = `module Acme\n  class Error < StandardError; end\n  module Web\n    class Server\n      def run; end\n    end\n  end\nend\nclass Acme::Web::Client\nend\nPoint = Struct.new(:x, :y)\nclass Other\n  class << self\n    def x; end\n  end\nend\n`;
    expect(rubyDeclarations(src)).toEqual(["Acme", "Acme::Error", "Acme::Web", "Acme::Web::Server", "Acme::Web::Client", "Point", "Other"]);
  });

  it("does not declare names that only appear in comments, strings or heredocs", () => {
    const src = `# class Fake\nx = <<-SQL\n  class Nope\nSQL\ns = "module AlsoNope"\ny = %w[class Neither]\nclass Real\nend\n`;
    expect(rubyDeclarations(src)).toEqual(["Real"]);
  });

  it("does not take an append or a division for a heredoc or regex", () => {
    const src = `list << Item\nz = a / b\nclass Real; end\nw = c /d\nclass Second\nend\n`;
    expect(rubyDeclarations(src)).toEqual(["Real", "Second"]);
  });
});

describe("file filtering and kinds", () => {
  it("skips specs and features but not look-alike names", () => {
    for (const p of ["spec/models/user_spec.rb", "features/step_definitions/x.rb", "lib/foo/spec/helper.rb"]) expect(isAnalyzableSource(p), p).toBe(false);
    for (const p of ["lib/acme/specification.rb", "app/models/user.rb"]) expect(isAnalyzableSource(p), p).toBe(true);
  });
  it("classifies Rails controllers as API and models as data", () => {
    expect(classifyPath("app/controllers/users_controller.rb")).toBe("api");
    expect(classifyPath("app/models/user.rb")).toBe("data");
  });
});

const files = [
  { path: "lib/acme.rb", content: `require "acme/version"\nrequire_relative "acme/client"\n\nmodule Acme\n  def self.client = Client.new\nend\n` },
  { path: "lib/acme/version.rb", content: `module Acme\n  VERSION = "1"\nend\n` },
  { path: "lib/acme/client.rb", content: `require "json"\nrequire "acme/http/request"\n\nmodule Acme\n  class Client\n    def get(url) = Http::Request.new(url).send\n    def fail! = raise(Error, "x")\n  end\nend\n` },
  { path: "lib/acme/error.rb", content: `module Acme\n  class Error < StandardError; end\nend\n` },
  { path: "lib/acme/http/request.rb", content: `module Acme\n  module Http\n    class Request\n      def send = Response.new\n    end\n  end\nend\n` },
  { path: "lib/acme/http/response.rb", content: `module Acme\n  module Http\n    class Response; end\n  end\nend\n` },
  { path: "lib/acme/other_error.rb", content: `module Other\n  class Error < StandardError; end\nend\n` },
  { path: "lib/acme/compact.rb", content: `class Acme::Compact\nend\n` },
  { path: "app/models/user.rb", content: `class User < ApplicationRecord\n  has_many :posts\n  def label = Slug.make(name)\nend\n` },
  { path: "app/models/application_record.rb", content: `class ApplicationRecord < ActiveRecord::Base\nend\n` },
  { path: "app/models/post.rb", content: `class Post\n  belongs_to :user\n  def author = User.find(1)\nend\n` },
  { path: "lib/slug.rb", content: `module Slug\n  def self.make(s) = s\nend\n` },
];
const graph = buildHeuristicGraph("acme", files);
const idOf = (path: string) => graph.nodes.find((n) => n.data.filePath === path)!.id;
const edge = (from: string, to: string) => graph.edges.find((e) => e.source === idOf(from) && e.target === idOf(to));

describe("Ruby edges", () => {
  it("follows require (through lib/) and require_relative", () => {
    expect(edge("lib/acme.rb", "lib/acme/version.rb")).toBeDefined();
    expect(edge("lib/acme.rb", "lib/acme/client.rb")?.samePackage).toBeUndefined();
    expect(edge("lib/acme/client.rb", "lib/acme/http/request.rb")).toBeDefined();
  });

  it("links a mentioned constant to the file declaring it, with the constant as symbol", () => {
    expect(edge("lib/acme.rb", "lib/acme/client.rb")?.symbols).toContain("Acme::Client");
    expect(edge("lib/acme/http/request.rb", "lib/acme/http/response.rb")?.symbols).toEqual(["Acme::Http::Response"]);
    expect(edge("app/models/user.rb", "lib/slug.rb")?.symbols).toEqual(["Slug"]);
    expect(edge("app/models/post.rb", "app/models/user.rb")?.symbols).toEqual(["User"]);
  });

  it("links Rails-style constants with no require at all, and a real dependency is not samePackage", () => {
    const e = edge("app/models/user.rb", "app/models/application_record.rb");
    expect(e?.symbols).toEqual(["ApplicationRecord"]);
    expect(e?.samePackage).toBeUndefined();
  });

  it("prefers the declaration in the file's own namespace when a name is declared twice", () => {
    expect(edge("lib/acme/client.rb", "lib/acme/error.rb")?.symbols).toEqual(["Acme::Error"]);
    expect(edge("lib/acme/client.rb", "lib/acme/other_error.rb")).toBeUndefined();
  });

  it("marks sibling-namespace use samePackage, but not when the file also requires it", () => {
    expect(edge("lib/acme/client.rb", "lib/acme/error.rb")?.samePackage).toBe(true);
    expect(edge("lib/acme/client.rb", "lib/acme/http/request.rb")?.samePackage).toBeUndefined();
  });

  it("links a file that declares Acme::Compact to the file that opens Acme as samePackage", () => {
    const e = edge("lib/acme/compact.rb", "lib/acme.rb");
    expect(e?.samePackage).toBe(true);
    expect(e?.symbols).toEqual(["Acme"]);
  });

  it("does not link names no file declares (ActiveRecord::Base, StandardError)", () => {
    const targets = graph.edges.filter((e) => e.source === idOf("app/models/application_record.rb"));
    expect(targets).toEqual([]);
  });

  it("has no self edges", () => {
    expect(graph.edges.filter((e) => e.source === e.target)).toEqual([]);
  });
});

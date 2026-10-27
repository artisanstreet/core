// Bundled skill refs against Core's published schema:
// SkillFile { path, contentBase64: base64url, sha256: hex }.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import * as C from "../../src/contracts/v1.ts";
import { build_skill_bundle } from "../src/skills-bundle.ts";
import { transcript_text } from "../src/forge.ts";

function file(path: string, content: string): File {
  const f = new File([content], path.split("/").pop() ?? path, { type: "text/plain" });
  Object.defineProperty(f, "webkitRelativePath", { value: `my-skill/${path}` });
  return f;
}

describe("skill bundle building (Core SkillFile shape)", () => {
  it("bundles SKILL.md plus support files with base64url + sha256", async () => {
    const built = await build_skill_bundle({
      folder_name: "my-skill",
      files: [file("SKILL.md", "# hi"), file("helpers/a.md", "help")],
    });
    expect(built.name).toBe("my-skill");
    expect(built.source).toBe("bundle");
    expect(built.bundle.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "helpers/a.md"]);
    const md = built.bundle.files.find((f) => f.path === "SKILL.md");
    const raw = new TextEncoder().encode("# hi");
    expect(md?.contentBase64).toBe(Buffer.from(raw).toString("base64url"));
    expect(md?.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(built.skipped).toEqual([]);
  });

  it("requires SKILL.md at the root", async () => {
    await expect(build_skill_bundle({ folder_name: "x", files: [file("other.md", "nope")] })).rejects.toThrow(/SKILL\.md/);
  });

  it("refuses secret-looking and tool folders by name, keeps the rest", async () => {
    const built = await build_skill_bundle({
      folder_name: "my-skill",
      files: [
        file("SKILL.md", "# hi"),
        file(".env", "KEY=1"),
        file("node_modules/dep/index.js", "x"),
        file("creds/secrets.json", "{}"),
      ],
    });
    expect(built.bundle.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(built.skipped.join(" ")).toMatch(/\.env/);
    expect(built.skipped.join(" ")).toMatch(/node_modules/);
    expect(built.skipped.join(" ")).toMatch(/secrets\.json/);
  });

  it("every produced file validates strictly against Core's SkillFile", async () => {
    const built = await build_skill_bundle({ folder_name: "s", files: [file("SKILL.md", "# hi")] });
    for (const f of built.bundle.files) {
      expect(() => Schema.decodeUnknownSync(C.SkillFile, { onExcessProperty: "error" })(f)).not.toThrow();
    }
    const ref = Schema.decodeUnknownSync(C.SkillRef, { onExcessProperty: "error" })({
      name: built.name,
      source: built.source,
      bundle: built.bundle,
    });
    expect(ref.bundle?.files).toHaveLength(1);
  });

  it("Core rejects unknown bundle fields and bad hashes", () => {
    expect(() =>
      Schema.decodeUnknownSync(C.SkillFile, { onExcessProperty: "error" })({
        path: "SKILL.md",
        contentBase64: Buffer.from("hi").toString("base64url"),
        sha256: "not-hex",
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("transcript extractor (contract shapes)", () => {
  it("preserves ALL message parts in defined order, uncapped", () => {
    const parts = Array.from({ length: 20 }, (_, i) => `part-${i}`);
    const kind = {
      type: "assistant_message",
      text: parts.join("\n"),
      phase: "final",
    };
    const t = transcript_text(kind);
    for (const p of parts) expect(t.text).toContain(p);
    expect(t.stored).toEqual([]);
  });

  it("walks tool calls, outputs, approvals, and questions fully", () => {
    const kind = {
      type: "tool",
      tool: { kind: "shell", command: "make test", cwd: "/repo" },
      title: "Run tests",
      output: { text: "ok ".repeat(1000), omitted_bytes: 0 },
      exit_code: 0,
      approval: null,
    };
    const t = transcript_text(kind);
    expect(t.text).toContain("Run tests");
    expect(t.text).toContain("make test");
    expect(t.text).toContain("ok ok");
    expect(t.text.length).toBeGreaterThan(2900);
    const q = transcript_text({
      type: "question",
      blocking: true,
      questions: [
        { id: "q1", header: "H", text: "Pick?", multi_select: false, options: [{ id: "a", label: "A", description: null }, { id: "b", label: "B", description: null }] },
        { id: "q2", header: null, text: "More?", multi_select: true, options: [{ id: "c", label: "C", description: null }] },
      ],
      answers: null,
    });
    expect(q.text).toContain("Pick?");
    expect(q.text).toContain("More?");
    expect(q.text).toContain("A");
    expect(q.text).toContain("C");
  });

  it("surfaces stored refs and omitted bytes explicitly", () => {
    const t = transcript_text({ type: "assistant_message", text: { id: "abc123", bytes: 9000 } });
    expect(t.text).toBe("");
    expect(t.stored).toEqual([{ id: "abc123", bytes: 9000, label: "reply" }]);
    const t2 = transcript_text({ type: "tool", tool: { kind: "shell", command: "x" }, output: { text: "part", omitted_bytes: 12 } });
    expect(t2.notices.join(" ")).toMatch(/12.*omitted/);
  });

  it("falls back to generic reads on unknown future variants", () => {
    const t = transcript_text({ type: "hologram", text: "future-shape" });
    expect(t.text).toContain("future-shape");
  });
});

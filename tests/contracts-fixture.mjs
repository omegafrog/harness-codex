import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { sealContracts } from "../src/contracts/contracts.mjs";

const exec = promisify(execFile);
const git = (root, args) => exec("git", args, { cwd: root });
const kinds = [
  ["system", "external-system", null, "설명,인터페이스,외부 명세"], ["context", "bounded-context", null, "설명,커뮤니케이션,내부 구성요소,배포"],
  ["booking", "aggregate", "context", "설명,기능,구성요소,불변식"], ["root", "aggregate-root", "booking", "설명,속성,메서드"],
  ["entity", "entity", "booking", "설명,속성,메서드"], ["money", "value-object", "booking", "설명,속성,불변식"],
  ["policy", "domain-service", "context", "설명,속성,메서드,비즈니스 규칙"], ["reserve", "domain-method", "policy", "설명,비즈니스 규칙"],
  ["flow", "composition-service", "context", "설명,필요 엔티티,동작,메서드"], ["run", "composition-method", "flow", "설명,필요 엔티티,동작"],
];

export async function makeContractsFixture({ commit = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-contracts-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/app.mjs"), "export const app = true;\n");
  await mkdir(join(root, "docs/contracts/diagrams"), { recursive: true });
  const components = kinds.map(([id, kind, owner]) => ({ id, name: id, kind, owner, updated_at: "2026-01-01", features: ["booking-feature"], sources: ["src/app.mjs"] }));
  const features = [{ id: "booking-feature", name: "예약", updated_at: "2026-01-01", status: "implemented" }];
  const diagrams = [{ kind: "ddd", source: "docs/contracts/diagrams/ddd.puml" }, { kind: "sequence", feature: "booking-feature", source: "docs/contracts/diagrams/sequence.puml" }, { kind: "state", feature: "booking-feature", reason: "상태 없음" }, { kind: "class", reason: "클래스 상세 불필요" }];
  const manifest = { schema_version: 1, revision: 1, updated_at: "2026-01-01", change_summary: "초기 계약", features, components, diagrams, source_roots: ["src"], hashes: {} };
  const section = (item, fields, extra = "") => `<a id="${item.id}"></a>\n## ${item.name}\n수정일: ${item.updated_at}\n${fields.map((f) => `### ${f}\n내용`).join("\n")}\n${extra}\n`;
  const product = section(features[0], ["설명", "비즈니스 규칙", "수용 조건"]);
  const architecture = components.map((c) => {
    const fields = kinds.find(([id]) => id === c.id)[3].split(",");
    const links = components.filter((x) => x.owner === c.id).map((x) => `[${x.name}](architecture.md#${x.id})`).join("\n");
    const table = ["entity", "aggregate-root", "value-object", "domain-service"].includes(c.kind) ? "| 속성 | 타입 |\n|---|---|\n| id | string |" : "";
    return section(c, fields, `${links}\n${table}\n${c.kind === "external-system" ? "[외부 명세](https://example.com/spec)" : ""}`);
  }).join("\n");
  await writeFile(join(root, "docs/contracts/product.md"), product);
  await writeFile(join(root, "docs/contracts/architecture.md"), architecture);
  await writeFile(join(root, "CONTEXT.md"), "# Context\n");
  await writeFile(join(root, "CONTEXT-MAP.md"), "# Map\n");
  for (const d of diagrams.filter((x) => x.source)) {
    const source = `@startuml\n${d.kind === "ddd" ? components.map((c) => `[[../architecture.md#${c.id} ${c.name}]]`).join("\n") : "booking"}\n@enduml\n`;
    const hash = createHash("sha256").update(source).digest("hex");
    await writeFile(join(root, d.source), source);
    await writeFile(join(root, d.source.replace(/\.puml$/, ".svg")), `<svg>${d.kind === "ddd" ? components.map((c) => `<a xlink:href="../architecture.md#${c.id}">${c.name}</a>`).join(" ") : ""} harness-source-sha256: ${hash}</svg>`);
  }
  await writeFile(join(root, "docs/contracts/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await git(root, ["add", "."]);
  if (commit) await git(root, ["commit", "-qm", "draft docs"]);
  const sealed = await sealContracts({ workspace_root: root, change_summary: "검토 완료" });
  assert.equal(sealed.status, "pass", sealed.violations.join("; "));
  if (commit) {
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "baseline"]);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

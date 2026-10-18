import { readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const DIRECTORY = "docs/contracts";
const MANIFEST = `${DIRECTORY}/manifest.json`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "") && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const text = (value) => typeof value === "string" && value.trim().length > 0;
const kinds = {
  "external-system": ["설명", "인터페이스", "외부 명세"],
  "bounded-context": ["설명", "커뮤니케이션", "내부 구성요소", "배포"],
  aggregate: ["설명", "기능", "구성요소", "불변식"],
  "aggregate-root": ["설명", "속성", "메서드"],
  entity: ["설명", "속성", "메서드"],
  "value-object": ["설명", "속성", "불변식"],
  "domain-service": ["설명", "속성", "메서드", "비즈니스 규칙"],
  "domain-method": ["설명", "비즈니스 규칙"],
  "composition-service": ["설명", "필요 엔티티", "동작", "메서드"],
  "composition-method": ["설명", "필요 엔티티", "동작"],
};

async function safePath(root, path) {
  if (!text(path) || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`Invalid relative path: ${path}`);
  const target = resolve(root, path);
  const actual = await realpath(target);
  const rel = relative(await realpath(root), actual);
  if (rel.startsWith("..") || isAbsolute(rel) || (await lstat(target)).isSymbolicLink()) throw new Error(`Path escapes workspace or is a symlink: ${path}`);
  return target;
}
const read = async (root, path) => readFile(await safePath(root, path), "utf8");
function git(root, args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function previous(root, baseRef) {
  const ref = baseRef || "HEAD";
  if (!/^[a-zA-Z0-9_./~-]+$/.test(ref) || ref.startsWith("-")) throw new Error("Invalid base ref");
  try { git(root, ["rev-parse", "--verify", `${ref}^{commit}`]); }
  catch (error) {
    if (baseRef || git(root, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") throw error;
    return null;
  }
  if (!git(root, ["ls-tree", "--name-only", ref, "--", MANIFEST]).trim()) return null;
  return JSON.parse(git(root, ["show", `${ref}:${MANIFEST}`]));
}
function sections(markdown) {
  return new Map([...markdown.matchAll(/<a id="([a-z][a-z0-9-]*)"><\/a>\s*\n## ([^\n]+)\n([\s\S]*?)(?=<a id="|$)/g)].map((m) => [m[1], { name: m[2].trim(), body: m[3] }]));
}
function model(manifest) {
  const { revision, updated_at, change_summary, no_contract_change, hashes, ...content } = manifest;
  return content;
}
async function snapshot(root, manifest) {
  const files = new Set([`${DIRECTORY}/product.md`, `${DIRECTORY}/architecture.md`, "CONTEXT.md", "CONTEXT-MAP.md"]);
  if (!Array.isArray(manifest.source_roots) || !manifest.source_roots.length) throw new Error("source_roots must cover the implementation");
  for (const path of new Set([...manifest.source_roots, "docs/specs", "docs/plans"])) {
    if (path === "." || path.startsWith(DIRECTORY) || path.startsWith(".git/")) throw new Error(`Invalid source root: ${path}`);
    if (manifest.source_roots.includes(path)) await safePath(root, path);
    const paths = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", path]).split("\0").filter(Boolean);
    for (const source of paths) {
      if (source.startsWith("docs/plans/.runtime/")) continue;
      // Deleted tracked paths belong to the previous snapshot; their absence must change the hash set.
      try { await lstat(resolve(root, source)); files.add(source); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  for (const diagram of manifest.diagrams || []) {
    if (diagram.source) { files.add(diagram.source); files.add(diagram.source.replace(/\.puml$/, ".svg")); }
  }
  const hashes = { "@model": sha(JSON.stringify(model(manifest))) };
  for (const path of [...files].sort()) hashes[path] = sha(await readFile(await safePath(root, path)));
  return hashes;
}
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function prose(body) {
  return escape(body).replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    if (!/^(https:\/\/|(?:\.\.\/)*[a-zA-Z0-9_./#-]+$)/.test(href)) return match;
    return `<a href="${href.replace(/^architecture\.md#/, "#")}">${label}</a>`;
  });
}
async function viewer(root, manifest) {
  const architecture = sections(await read(root, `${DIRECTORY}/architecture.md`));
  const overview = manifest.diagrams.find((d) => d.kind === "ddd");
  let svg = overview?.source ? await read(root, overview.source.replace(/\.puml$/, ".svg")) : "";
  // Inline only local generated SVG; reject executable markup and remote resource loads.
  if (/<(?:script|foreignObject|image|use)\b|\bon[a-z]+\s*=|(?:javascript|data):/i.test(svg)) throw new Error("Unsafe SVG content");
  svg = svg.replace(/(?:xlink:)?href="[^"#]*architecture\.md#([a-z0-9-]+)"/g, 'href="#$1"').replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, "");
  const details = [...architecture].map(([id, section]) => `<section id="${id}"><h2>${escape(section.name)}</h2><pre>${prose(section.body)}</pre></section>`).join("\n");
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>DDD 아키텍처</title><style>body{max-width:1200px;margin:2rem auto;font:16px system-ui;padding:1rem}svg{max-width:100%;height:auto}pre{white-space:pre-wrap;line-height:1.6}section:target{background:#fff5cc}a{color:#174eb6}</style><h1>DDD 아키텍처 · v${manifest.revision}</h1>${svg}${details}</html>\n`;
}

async function validate(root, manifest) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  require(manifest.schema_version === 1, "Unsupported schema_version");
  require(Number.isInteger(manifest.revision) && manifest.revision > 0, "revision must be a positive integer");
  require(validDate(manifest.updated_at), "updated_at must be YYYY-MM-DD");
  require(text(manifest.change_summary), "change_summary is required");
  require(Array.isArray(manifest.features) && manifest.features.length > 0, "features are required");
  require(Array.isArray(manifest.components) && manifest.components.length > 0, "components are required");
  require(Array.isArray(manifest.diagrams), "diagrams are required");
  if (errors.length) return errors;
  const productText = await read(root, `${DIRECTORY}/product.md`);
  const architectureText = await read(root, `${DIRECTORY}/architecture.md`);
  const product = sections(productText), architecture = sections(architectureText);
  const ids = new Set();
  const checkSection = (item, document, fields) => {
    require(/^[a-z][a-z0-9-]*$/.test(item.id || "") && !ids.has(item.id), `Invalid or duplicate ID: ${item.id}`); ids.add(item.id);
    const section = document.get(item.id);
    require(section?.name === item.name, `Missing/named differently: ${item.id}`);
    require(validDate(item.updated_at), `Missing date: ${item.id}`);
    require(section?.body.includes(`수정일: ${item.updated_at}`), `Section date mismatch: ${item.id}`);
    for (const field of fields) require(new RegExp(`^### ${field}\\s*\\n(?=\\S)(?!###)[\\s\\S]+`, "m").test(section?.body || ""), `Missing ${field}: ${item.id}`);
    return section?.body || "";
  };
  require(product.size === manifest.features.length, "Product sections must match feature inventory without duplicates");
  require(architecture.size === manifest.components.length, "Architecture sections must match component inventory without duplicates");
  for (const feature of manifest.features) {
    checkSection(feature, product, ["설명", "비즈니스 규칙", "수용 조건"]);
    require(["implemented", "accepted-target", "retired"].includes(feature.status), `Invalid feature status: ${feature.id}`);
    require(manifest.components.some((c) => c.features?.includes(feature.id)), `Feature has no architecture owner: ${feature.id}`);
    if (feature.status !== "retired") require(manifest.diagrams.some((d) => d.kind === "sequence" && d.feature === feature.id && d.source), `Missing sequence: ${feature.id}`);
    require(manifest.diagrams.some((d) => d.kind === "state" && d.feature === feature.id && (d.source || text(d.reason))), `Missing state or reason: ${feature.id}`);
  }
  for (const component of manifest.components) {
    const body = checkSection(component, architecture, kinds[component.kind] || []);
    require(Object.hasOwn(kinds, component.kind), `Unknown component kind: ${component.id}`);
    if (!["external-system", "bounded-context"].includes(component.kind)) require(manifest.components.some((c) => c.id === component.owner), `Missing owner: ${component.id}`);
    let ancestor = component, seen = new Set([component.id]);
    while (ancestor.owner) {
      const parent = manifest.components.find((c) => c.id === ancestor.owner);
      if (!parent) break;
      if (seen.has(parent.id)) { require(false, `Owner cycle: ${component.id}`); break; }
      seen.add(parent.id); ancestor = parent;
    }
    if (component.kind === "aggregate-root") require(manifest.components.some((c) => c.id === component.owner && c.kind === "aggregate"), `Root must belong to aggregate: ${component.id}`);
    if (component.kind.endsWith("-method")) require(manifest.components.some((c) => c.id === component.owner && ["domain-service", "composition-service", "entity", "aggregate-root", "value-object"].includes(c.kind)), `Method must belong to an object/service: ${component.id}`);
    for (const feature of component.features || []) require(manifest.features.some((f) => f.id === feature), `Unknown feature: ${feature}`);
    if (component.kind === "external-system") require(/\[[^\]]+\]\(https:\/\/[^)]+\)/.test(body), `Missing external specification URL: ${component.id}`);
    if (["entity", "aggregate-root", "value-object", "domain-service"].includes(component.kind)) require(/\|[^\n]*타입[^\n]*\|/.test(body), `Attribute type table required: ${component.id}`);
    if (component.kind === "aggregate") require(manifest.components.filter((c) => c.owner === component.id && c.kind === "aggregate-root").length === 1, `Aggregate must have one root: ${component.id}`);
    for (const child of manifest.components.filter((c) => c.owner === component.id)) require(body.includes(`architecture.md#${child.id})`), `Missing child link: ${component.id} -> ${child.id}`);
    for (const source of component.sources || []) await safePath(root, source);
  }
  require(manifest.diagrams.some((d) => d.kind === "ddd" && d.source), "Missing DDD diagram");
  require(manifest.diagrams.some((d) => d.kind === "class" && (d.source || text(d.reason))), "Missing class diagram or reason");
  for (const diagram of manifest.diagrams) {
    require(["ddd", "class", "sequence", "state"].includes(diagram.kind), `Unknown diagram kind: ${diagram.kind}`);
    if (!diagram.source) { require(diagram.kind !== "ddd" && diagram.kind !== "sequence" && text(diagram.reason), "Diagram omission needs a reason"); continue; }
    require(diagram.source.startsWith(`${DIRECTORY}/diagrams/`) && diagram.source.endsWith(".puml"), `Invalid diagram path: ${diagram.source}`);
    const source = await read(root, diagram.source), svg = await read(root, diagram.source.replace(/\.puml$/, ".svg"));
    require(!/^\s*!include/m.test(source), `Canonical diagrams must be self-contained: ${diagram.source}`);
    require(svg.includes(`harness-source-sha256: ${sha(source)}`), `Stale/unverified SVG: ${diagram.source}`);
    require(svg.includes("<svg"), `Invalid SVG: ${diagram.source}`);
    if (diagram.kind === "ddd") for (const component of manifest.components) {
      require(source.includes(`../architecture.md#${component.id}`) && source.includes(component.name), `Missing named DDD node link: ${component.id}`);
      require(new RegExp(`<a\\s+[^>]*\\b(?:xlink:)?href=["']\\.\\./architecture\\.md#${component.id}["']`).test(svg), `Missing SVG link: ${component.id}`);
    }
  }
  for (const [path, content] of [[`${DIRECTORY}/product.md`, productText], [`${DIRECTORY}/architecture.md`, architectureText]]) {
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1]; if (/^https:\/\//.test(href)) continue;
      const [file, anchor] = href.split("#");
      const target = file ? relative(root, resolve(root, dirname(path), file)) : path;
      const linked = await read(root, target);
      if (anchor) require(linked.includes(`<a id="${anchor}"></a>`), `Broken anchor: ${path} -> ${href}`);
    }
  }
  return errors;
}

export async function inspectContracts({ workspace_root, base_ref = null } = {}) {
  try {
    if (!isAbsolute(workspace_root || "")) throw new Error("Absolute workspace_root is required");
    const manifest = JSON.parse(await read(workspace_root, MANIFEST));
    const errors = await validate(workspace_root, manifest);
    const hashes = await snapshot(workspace_root, manifest);
    if (JSON.stringify(hashes) !== JSON.stringify(manifest.hashes)) errors.push("Contract/source snapshot changed; reconcile and seal");
    const old = previous(workspace_root, base_ref);
    if (old && JSON.stringify(old) !== JSON.stringify(manifest) && manifest.revision <= old.revision) errors.push("Contract revision must increase from base");
    if (await read(workspace_root, `${DIRECTORY}/architecture.html`) !== await viewer(workspace_root, manifest)) errors.push("Architecture HTML is stale");
    return { status: errors.length ? "fail" : "pass", reason: errors.length ? "contracts_out_of_sync" : "contracts_current", revision: manifest.revision, violations: errors, evidence_path: MANIFEST };
  } catch (error) {
    return { status: "fail", reason: "contracts_invalid", violations: [error.message], evidence_path: MANIFEST };
  }
}

export async function sealContracts({ workspace_root, change_summary, no_contract_change = null } = {}) {
  if (!isAbsolute(workspace_root || "")) throw new Error("Absolute workspace_root is required");
  if (!text(change_summary)) throw new Error("A review change summary is required");
  const manifest = JSON.parse(await read(workspace_root, MANIFEST));
  const hashes = await snapshot(workspace_root, manifest);
  const old = previous(workspace_root);
  const baseline = manifest.hashes || old?.hashes;
  const sourcesChanged = baseline && Object.keys({ ...baseline, ...hashes }).some((p) => !p.startsWith(DIRECTORY) && p !== "@model" && baseline[p] !== hashes[p]);
  const docsChanged = !baseline || ["product.md", "architecture.md"].some((p) => baseline[`${DIRECTORY}/${p}`] !== hashes[`${DIRECTORY}/${p}`]);
  if (sourcesChanged && !docsChanged && !text(no_contract_change)) throw new Error("Source changed without contract edits; record a reviewed no_contract_change reason or update the contract");
  if (JSON.stringify(hashes) === JSON.stringify(manifest.hashes)) return inspectContracts({ workspace_root });
  manifest.revision = Math.max(manifest.revision || 0, old?.revision || 0) + 1;
  manifest.updated_at = new Date().toISOString().slice(0, 10);
  manifest.change_summary = change_summary;
  manifest.no_contract_change = no_contract_change;
  manifest.hashes = hashes;
  const errors = await validate(workspace_root, manifest);
  if (errors.length) throw new Error(errors.join("\n"));
  const html = await viewer(workspace_root, manifest);
  // The generated view may not exist on first setup; validate its existing parent before creating it.
  const htmlPath = resolve(await safePath(workspace_root, DIRECTORY), "architecture.html");
  try {
    const info = await lstat(htmlPath);
    if (info.isSymbolicLink()) throw new Error("Generated HTML must not be a symlink");
    await safePath(workspace_root, `${DIRECTORY}/architecture.html`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(htmlPath, html);
  await writeFile(await safePath(workspace_root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return inspectContracts({ workspace_root });
}

export async function runContractsCli(argv = process.argv.slice(2)) {
try {
  const [command, ...args] = argv;
  const options = { workspace_root: process.cwd() };
  const flags = { '--root': 'workspace_root', '--base-ref': 'base_ref', '--summary': 'change_summary', '--no-contract-change': 'no_contract_change' };
  for (let i = 0; i < args.length; i++) {
    if (!flags[args[i]] || !args[i + 1]) throw new Error(`Unknown/missing argument: ${args[i]}`);
    options[flags[args[i]]] = args[++i];
  }
  options.workspace_root = resolve(options.workspace_root);
  if (!['check', 'seal'].includes(command)) throw new Error('Usage: harness-contracts.mjs check|seal [--root DIR] [--base-ref REF] [--summary TEXT] [--no-contract-change REASON]');
  const result = await (command === 'seal' ? sealContracts : inspectContracts)(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runContractsCli();

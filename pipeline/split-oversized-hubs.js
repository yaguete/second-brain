#!/usr/bin/env node
/**
 * One-shot hub/child split for oversized entity hubs.
 * Deterministic: moves named ## sections into child pages; hub keeps a link stub.
 *
 * Idempotent: if the child already exists with real content and the hub no longer
 * has those sections, the plan is skipped (does not overwrite children with stubs).
 *
 * Usage: node --env-file=.env scripts/split-oversized-hubs.js [--dry-run]
 */
import fs from "fs";
import path from "path";
import { buildWikiIndexMarkdown, parseFrontmatter } from "./lib/brain-wiki.js";

import { requireVaultPath, wikiDirName } from "./lib/layout.js";
const VAULT_ROOT = requireVaultPath();
const WIKI = path.join(VAULT_ROOT, wikiDirName());
const ENT = path.join(WIKI, "entities");
const DRY = process.argv.includes("--dry-run");
const today = new Date().toISOString().slice(0, 10);

/** @returns {{ title: string, body: string }[]} */
function splitSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = { title: null, lines: [] };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      sections.push({ title: current.title, body: current.lines.join("\n").replace(/^\n+/, "") });
      current = { title: m[1].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push({ title: current.title, body: current.lines.join("\n").replace(/^\n+/, "") });
  return sections;
}

/** Parte una sección `##` en cabecera + intro + subsecciones `###`. */
function splitSubsections(sectionBody) {
  const lines = sectionBody.split(/\r?\n/);
  const head = lines.shift();
  const intro = [];
  const subs = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^###\s+(.+)$/);
    if (m) {
      if (current) subs.push(current);
      current = { title: m[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  if (current) subs.push(current);
  return {
    head,
    intro: intro.join("\n").trim(),
    subs: subs.map((x) => ({ title: x.title, body: x.lines.join("\n").trimEnd() }))
  };
}

/** Une secciones "Ver también"/"See also" repetidas en una, sin líneas duplicadas. */
function mergeDuplicateSeeAlso(sections) {
  const out = [];
  let seeAlso = null;
  for (const sec of sections) {
    if (!/^ver también$|^see also$/i.test(sec.title)) {
      out.push(sec);
      continue;
    }
    if (!seeAlso) {
      seeAlso = { ...sec };
      out.push(seeAlso);
      continue;
    }
    const have = new Set(seeAlso.body.split("\n").map((l) => l.trim()));
    const extra = sec.body
      .split("\n")
      .slice(1)
      .filter((l) => l.trim() && !have.has(l.trim()));
    if (extra.length) seeAlso.body = `${seeAlso.body.trimEnd()}\n${extra.join("\n")}`;
  }
  return out;
}

function yamlString(v) {
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

function writeChild({ filename, title, intro, sections, parentSlug, parentTitle, tags }) {
  const body = [
    `# ${title}`,
    "",
    intro,
    "",
    ...sections.map((s) => s.body.trimEnd()),
    "",
    "## See also",
    "",
    `- [[${parentSlug}|${parentTitle}]]`,
    ""
  ].join("\n");

  const md = `---
title: ${yamlString(title)}
type: entity
created: ${today}
updated: ${today}
sources:
  - ${yamlString(`📒 Wiki/entities/${parentSlug}.md`)}
tags:
${tags.map((t) => `  - ${t}`).join("\n")}
---

${body}`;

  const dest = path.join(ENT, filename);
  if (!DRY) fs.writeFileSync(dest, md, "utf8");
  return { dest, chars: md.length, filename, title };
}

function rebuildHub(raw, keepTitles, children, hubSlug, movedSubs = new Set()) {
  const { data, body } = parseFrontmatter(raw);
  const sections = splitSections(body);
  const preamble = sections.find((s) => s.title === null)?.body?.trim() || `# ${data.title}\n`;
  const kept = mergeDuplicateSeeAlso(
    sections
      .filter((s) => s.title && keepTitles.has(s.title))
      .map((s) => {
        const parsed = splitSubsections(s.body);
        if (!parsed.subs.some((x) => movedSubs.has(x.title))) return s;
        const rest = parsed.subs.filter((x) => !movedSubs.has(x.title)).map((x) => x.body);
        return { title: s.title, body: [parsed.head, parsed.intro, ...rest].filter(Boolean).join("\n\n") };
      })
  );

  const childLinks = children
    .map((c) => `- [[${c.filename.replace(/\.md$/, "")}|${c.title}]] — ${c.blurb}`)
    .join("\n");

  const pagesSection = `## Páginas hijas

Detalle movido fuera del hub para mantener esta página por debajo del umbral de chunking del brain (~25 chunks). El hub sigue siendo canónico para identidad y estado actual.

${childLinks}
`;

  // Si el hub ya tiene "Páginas hijas" (split anterior), se añaden ahí los enlaces nuevos.
  const existingPagesIdx = kept.findIndex((s) => s.title === "Páginas hijas");
  const keptBodies = kept.map((s) => s.body.trimEnd());
  if (existingPagesIdx >= 0) {
    const current = keptBodies[existingPagesIdx];
    const newLinks = children
      .filter((c) => !current.includes(`[[${c.filename.replace(/\.md$/, "")}`))
      .map((c) => `- [[${c.filename.replace(/\.md$/, "")}|${c.title}]] — ${c.blurb}`);
    keptBodies[existingPagesIdx] = [current, ...newLinks].join("\n");
  } else {
    // Insert Páginas hijas before Ver también / See also if present, else at end
    const seeAlsoIdx = kept.findIndex((s) => /^ver también$|^see also$/i.test(s.title));
    if (seeAlsoIdx >= 0) {
      keptBodies.splice(seeAlsoIdx, 0, pagesSection.trimEnd());
    } else {
      keptBodies.push(pagesSection.trimEnd());
    }
  }

  const title = data.title ? String(data.title) : hubSlug;
  const fmLines = [
    `title: ${yamlString(title)}`,
    `type: entity`,
    `created: ${data.created || today}`,
    `updated: ${today}`
  ];
  if (data.sources) {
    const srcs = Array.isArray(data.sources) ? data.sources : [data.sources];
    fmLines.push("sources:");
    for (const s of srcs) fmLines.push(`  - ${yamlString(s)}`);
  }
  if (data.tags) {
    const tags = Array.isArray(data.tags) ? data.tags : [data.tags];
    fmLines.push("tags:");
    for (const t of tags) fmLines.push(`  - ${t}`);
  }

  return `---\n${fmLines.join("\n")}\n---\n\n${preamble.trim()}\n\n${keptBodies.join("\n\n")}\n`;
}

const MIN_EXISTING_CHILD_CHARS = 2_000;

/** Secciones que no van ni al hub (keep) ni a ninguna hija: se perderían al reconstruir. */
function unassignedSections(sections, plan, subByTitle, movedSubs) {
  const movedTitles = new Set(plan.children.flatMap((c) => c.sectionTitles || []));
  const out = [];
  for (const sec of sections) {
    if (!sec.title || plan.keep.has(sec.title) || movedTitles.has(sec.title)) continue;
    out.push(`## ${sec.title}`);
  }
  for (const [title, sub] of subByTitle) {
    if (!plan.keep.has(sub.parent) && !movedSubs.has(title)) out.push(`### ${title}`);
  }
  return out;
}

function childAlreadyExists(filename) {
  const dest = path.join(ENT, filename);
  if (!fs.existsSync(dest)) return { exists: false, chars: 0, path: dest };
  const chars = fs.readFileSync(dest, "utf8").length;
  return { exists: true, chars, path: dest };
}

function loadPlans(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.plans;
  if (!Array.isArray(list)) {
    console.error("--plan JSON must be an array or { plans: [] }");
    process.exit(1);
  }
  return list.map((plan) => ({ ...plan, keep: new Set(plan.keep || []) }));
}

function planFile() {
  const eq = process.argv.find((a) => a.startsWith("--plan="));
  if (eq) return eq.slice("--plan=".length);
  const i = process.argv.indexOf("--plan");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  console.error("Missing --plan <file.json>");
  process.exit(1);
}

function main() {
  const plans = loadPlans(planFile());
  const results = [];
  let anyWrite = false;

  for (const plan of plans) {
    const hubPath = path.join(ENT, plan.hub);
    if (!fs.existsSync(hubPath)) {
      console.warn(`SKIP hub missing: ${plan.hub}`);
      continue;
    }
    const raw = fs.readFileSync(hubPath, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const sections = splitSections(body);
    const byTitle = new Map(sections.filter((s) => s.title).map((s) => [s.title, s]));
    // Subsecciones ### movibles, dentro de las secciones ## listadas en subsectionParents.
    const subByTitle = new Map();
    for (const parent of plan.subsectionParents || []) {
      const sec = byTitle.get(parent);
      if (!sec) continue;
      for (const sub of splitSubsections(sec.body).subs) subByTitle.set(sub.title, { ...sub, parent });
    }
    const movedSubs = new Set();

    // Antes de escribir nada: si hay algo que mover, toda sección debe tener destino.
    const plannedSubs = new Set(
      plan.children.flatMap((c) => c.subsections?.titles || []).filter((t) => subByTitle.has(t))
    );
    const hasWork =
      plannedSubs.size > 0 ||
      plan.children.some((c) => (c.sectionTitles || []).some((t) => byTitle.has(t)));
    const orphans = hasWork ? unassignedSections(sections, plan, subByTitle, plannedSubs) : [];
    if (orphans.length) {
      console.error(
        `ABORT hub ${plan.hub}: secciones sin destino (ni keep ni hija), se perderían: ` +
          orphans.map((t) => `"${t}"`).join(", ")
      );
      process.exit(1);
    }

    const childMeta = [];
    let movedAny = false;
    let skippedChildren = 0;

    for (const child of plan.children) {
      const existing = childAlreadyExists(child.filename);
      const moved = [];
      const missing = [];
      for (const t of child.sectionTitles || []) {
        const sec = byTitle.get(t);
        if (!sec) {
          missing.push(t);
          continue;
        }
        moved.push(sec);
      }
      if (child.subsections) {
        const subs = [];
        for (const t of child.subsections.titles) {
          const sub = subByTitle.get(t);
          if (sub) subs.push(sub);
          else missing.push(`### ${t}`);
        }
        if (subs.length) {
          const heading = child.subsections.heading;
          moved.push({ title: heading, body: `## ${heading}\n\n${subs.map((x) => x.body).join("\n\n")}` });
          for (const x of subs) movedSubs.add(x.title);
        }
      }

      // Hija ya materializada (split previo): no pisar con un stub vacío.
      if (existing.exists && existing.chars >= MIN_EXISTING_CHILD_CHARS && moved.length === 0) {
        console.log(
          `SKIP child ${child.filename}: already exists (${existing.chars.toLocaleString()} chars) and no hub sections left to move`
        );
        childMeta.push({
          filename: child.filename,
          title: child.title,
          blurb: child.blurb,
          chars: existing.chars
        });
        skippedChildren++;
        continue;
      }

      if (moved.length === 0) {
        console.warn(
          `SKIP child ${child.filename}: 0 sections to move` +
            (missing.length ? ` (missing: ${missing.map((t) => `"${t}"`).join(", ")})` : "")
        );
        skippedChildren++;
        continue;
      }

      if (missing.length) {
        for (const t of missing) {
          console.warn(`  missing section "${t}" in ${plan.hub} (continuing with ${moved.length} found)`);
        }
      }

      if (existing.exists && existing.chars >= MIN_EXISTING_CHILD_CHARS) {
        console.warn(
          `SKIP overwrite ${child.filename}: already ${existing.chars.toLocaleString()} chars; ` +
            `hub still has ${moved.length} matching section(s) — resolve manually`
        );
        childMeta.push({
          filename: child.filename,
          title: child.title,
          blurb: child.blurb,
          chars: existing.chars
        });
        skippedChildren++;
        continue;
      }

      const parentSlug = plan.hub.replace(/\.md$/, "");
      const written = writeChild({
        filename: child.filename,
        title: child.title,
        intro: `Página hija de [[${parentSlug}|${data.title}]]. ${child.blurb}`,
        sections: moved,
        parentSlug,
        parentTitle: String(data.title),
        tags: child.tags
      });
      childMeta.push({ ...written, blurb: child.blurb });
      movedAny = true;
      anyWrite = true;
      console.log(
        `${DRY ? "[dry] " : ""}child ${child.filename}: ${written.chars.toLocaleString()} chars (${moved.length} sections)`
      );
    }

    if (!movedAny) {
      console.log(
        `SKIP hub ${plan.hub}: nothing to move` +
          (skippedChildren ? ` (${skippedChildren} child plan(s) already done or empty)` : "") +
          ` — hub stays at ${raw.length.toLocaleString()} chars`
      );
      results.push({ hub: plan.hub, before: raw.length, after: raw.length, children: childMeta, skipped: true });
      continue;
    }

    const newHub = rebuildHub(raw, plan.keep, childMeta, plan.hub.replace(/\.md$/, ""), movedSubs);
    if (!DRY) {
      fs.writeFileSync(hubPath, newHub, "utf8");
      anyWrite = true;
    }
    console.log(
      `${DRY ? "[dry] " : ""}hub ${plan.hub}: ${raw.length.toLocaleString()} → ${newHub.length.toLocaleString()} chars`
    );
    results.push({ hub: plan.hub, before: raw.length, after: newHub.length, children: childMeta });
  }

  const oversized = [];
  for (const name of fs.readdirSync(ENT)) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(ENT, name);
    const len = fs.readFileSync(full, "utf8").length;
    if (len >= 25_000) oversized.push({ name, len });
  }
  oversized.sort((a, b) => b.len - a.len);
  if (oversized.length) {
    console.log("\nStill oversized (≥25k chars) — need a new split plan or surgical updates:");
    for (const o of oversized.slice(0, 15)) {
      console.log(`  ${o.name}: ${o.len.toLocaleString()} chars`);
    }
  }

  if (!DRY && anyWrite) {
    const indexPath = path.join(WIKI, "index.md");
    fs.writeFileSync(indexPath, buildWikiIndexMarkdown(VAULT_ROOT, wikiDirName()), "utf8");
    console.log("Rebuilt index.md");
  } else if (!DRY && !anyWrite) {
    console.log("No hub/child writes; index.md unchanged.");
  }

  console.log("\nDone.");
}

main();

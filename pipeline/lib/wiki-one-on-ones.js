/**
 * 1:1s en la wiki. En el vault cada 1:1 es una nota propia (`tipo: 1-1`, `persona: "[[X]]"`,
 * `fecha`, por ejemplo en `💼 Work/People/1-1s/<Persona>/`). En la wiki, cada persona tiene
 * `entity-<persona>-1-1s.md`: una entrada `### 1-1 DD.MM.YYYY` por reunión de los últimos
 * tres meses, bajo `## 1:1s`. Las anteriores pasan a `entity-<persona>-1-1s-AAAA-qN.md`.
 */

import fs from "fs";
import path from "path";
import { parseFrontmatter } from "./brain-wiki.js";
import { parseMarkdownSections, serializeMarkdownSections } from "./wiki-sections.js";

const ENTRY_RE = /^### 1-1 (\d{2})\.(\d{2})\.(\d{4})\b/;
const SEE_ALSO_RE = /^(ver también|see also)$/i;

/** @returns {{ persona: string, fecha: string } | null} */
export function parseOneOnOneSource(raw) {
  const { data } = parseFrontmatter(String(raw || ""));
  if (String(data.tipo || "").trim() !== "1-1") return null;
  const persona = String(data.persona || "")
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    .trim();
  const fecha = String(data.fecha || "").trim();
  if (!persona || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  return { persona, fecha };
}

export function slugify(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Hub de la persona (`entity-<slug>.md`) y su página de 1:1s. */
export function oneOnOnePages(persona) {
  const hub = `entity-${slugify(persona)}`;
  return { hub, page: `${hub}-1-1s.md` };
}

export function isoToDmy(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** Motivo del update que fuerza la entrada del 1:1 en la página de 1:1s. */
export function oneOnOneUpdateReason({ persona, fecha }, sourceFilename) {
  const link = sourceFilename ? ` y termina con «Detalle: [[${sourceFilename.replace(/\.md$/, "")}]]»` : "";
  return (
    `Registrar el 1:1 con ${persona} del ${isoToDmy(fecha)}: añade bajo «## 1:1s» una entrada ` +
    `«### 1-1 ${isoToDmy(fecha)}» (orden cronológico, la más reciente al final) con 3–6 líneas: ` +
    `temas, acuerdos y próximos pasos${link}. No modifiques las demás entradas.`
  );
}

export function oneOnOnePageSkeleton({ persona, hub, today }) {
  const title = `${persona} — 1:1s`;
  return (
    `---\ntitle: ${JSON.stringify(title)}\ntype: entity\ncreated: ${today}\nupdated: ${today}\n` +
    `tags:\n  - 1-1\n  - ${hub.replace(/^entity-/, "")}\n---\n\n# ${title}\n\n` +
    `Registro de los 1:1 con [[${hub}|${persona}]] de los últimos tres meses: una entrada por reunión, ` +
    `con enlace a su página source. Los anteriores están en el archivo trimestral.\n\n` +
    `## 1:1s\n\n## Archivo\n\n## See also\n\n- [[${hub}|${persona}]]\n`
  );
}

/**
 * En `*-1-1s.md`, los `###` fechados de `## 1:1s` pasan al formato canónico
 * `### 1-1 DD.MM.YYYY[ — tema]` (el LLM a veces escribe `### 2026-10-02 — …`).
 */
export function normalizeOneOnOneHeadings(md, filename) {
  if (!filename.endsWith("-1-1s.md")) return md;
  const parsed = parseMarkdownSections(md);
  // `## Archivo` es solo la lista de archivos trimestrales; se descarta cualquier prosa del LLM.
  const archivo = parsed.sections.find((s) => s.title === "Archivo");
  let changed = false;
  if (archivo) {
    const links = archivo.body.split("\n").filter((l) => /^- \[\[[^\]]*-1-1s-\d{4}-q[1-4]\b/.test(l));
    const body = links.length ? `## Archivo\n\n${links.join("\n")}` : "## Archivo";
    changed = body !== archivo.body.trimEnd();
    archivo.body = body;
  }
  const sec = parsed.sections.find((s) => s.title === "1:1s");
  if (!sec) return changed ? serializeMarkdownSections(parsed) : md;
  const before = sec.body;
  sec.body = sec.body.replace(/^###\s+(.+)$/gm, (line, text) => {
    if (ENTRY_RE.test(line)) return line;
    const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    const dmy = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    const hit = iso || dmy;
    if (!hit) return line;
    const [y, mo, d] = iso ? [iso[1], iso[2], iso[3]] : [dmy[3], dmy[2], dmy[1]];
    const topic = text
      .slice(hit.index + hit[0].length)
      .replace(/^[\s—–\-·:|]+/, "")
      .trim();
    return `### 1-1 ${d.padStart(2, "0")}.${mo.padStart(2, "0")}.${y}${topic ? ` — ${topic}` : ""}`;
  });
  return sec.body === before && !changed ? md : serializeMarkdownSections(parsed);
}

function splitEntries(sectionBody) {
  const lines = sectionBody.split("\n");
  const head = [];
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^###\s/);
    if (m) {
      if (cur) entries.push(cur);
      cur = { title: line.replace(/^###\s+/, "").trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      head.push(line);
    }
  }
  if (cur) entries.push(cur);
  return {
    head: head.join("\n").trimEnd(),
    entries: entries.map((e) => {
      const m = e.lines[0].match(ENTRY_RE);
      return {
        title: e.title,
        body: e.lines.join("\n").trimEnd(),
        date: m ? `${m[3]}-${m[2]}-${m[1]}` : null
      };
    })
  };
}

function joinSection(head, entries) {
  return [head, ...entries.map((e) => e.body)].filter(Boolean).join("\n\n");
}

function monthsBefore(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Inserta `entries` en la sección `## <title>` (la crea antes de See also), sin duplicar y por fecha. */
function mergeEntriesInto(parsed, title, entries) {
  let idx = parsed.sections.findIndex((s) => s.title === title);
  if (idx < 0) {
    const see = parsed.sections.findIndex((s) => SEE_ALSO_RE.test(s.title));
    idx = see >= 0 ? see : parsed.sections.length;
    parsed.sections.splice(idx, 0, { title, body: `## ${title}` });
  }
  const { head, entries: have } = splitEntries(parsed.sections[idx].body);
  const titles = new Set(have.map((e) => e.title));
  const all = [...have, ...entries.filter((e) => !titles.has(e.title))];
  all.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  parsed.sections[idx].body = joinSection(head, all);
}

function addArchiveLink(parsed, line) {
  let idx = parsed.sections.findIndex((s) => s.title === "Archivo");
  if (idx < 0) {
    const see = parsed.sections.findIndex((s) => SEE_ALSO_RE.test(s.title));
    idx = see >= 0 ? see : parsed.sections.length;
    parsed.sections.splice(idx, 0, { title: "Archivo", body: "## Archivo" });
  }
  const body = parsed.sections[idx].body.trimEnd();
  if (body.includes(line)) return;
  parsed.sections[idx].body = /^## Archivo$/.test(body) ? `${body}\n\n${line}` : `${body}\n${line}`;
}

/**
 * Mueve las entradas de `## 1:1s` anteriores a `keepMonths` meses al archivo trimestral
 * (lo crea si falta y lo enlaza en `## Archivo`). Solo actúa en páginas `*-1-1s.md`.
 * @returns {string} markdown de la página ya rotado
 */
export function archiveOldOneOnOnes(md, { dirPath, filename, sourcePrefix, today, keepMonths = 3 }) {
  if (!filename.endsWith("-1-1s.md")) return md;
  const cutoff = monthsBefore(today, keepMonths);
  const page = parseMarkdownSections(md);
  const idx = page.sections.findIndex((s) => s.title === "1:1s");
  if (idx < 0) return md;
  const { head, entries } = splitEntries(page.sections[idx].body);
  const old = entries.filter((e) => e.date && e.date < cutoff);
  if (old.length === 0) return md;
  page.sections[idx].body = joinSection(
    head,
    entries.filter((e) => !old.includes(e))
  );

  const slug = filename.replace(/\.md$/, "");
  const pageTitle = String(parseFrontmatter(md).data.title || slug);
  const byQuarter = new Map();
  for (const e of old) {
    const q = `${e.date.slice(0, 4)}-q${Math.ceil(Number(e.date.slice(5, 7)) / 3)}`;
    if (!byQuarter.has(q)) byQuarter.set(q, []);
    byQuarter.get(q).push(e);
  }
  for (const [q, list] of byQuarter) {
    const archiveFn = `${slug}-${q}.md`;
    const archivePath = path.join(dirPath, archiveFn);
    const label = `${q.slice(5).toUpperCase()} ${q.slice(0, 4)}`;
    if (!fs.existsSync(archivePath)) {
      const title = `${pageTitle} (${label})`;
      fs.writeFileSync(
        archivePath,
        `---\ntitle: ${JSON.stringify(title)}\ntype: entity\ncreated: ${today}\nupdated: ${today}\n` +
          `sources:\n  - ${JSON.stringify(`${sourcePrefix}/${filename}`)}\ntags:\n  - 1-1\n---\n\n` +
          `# ${title}\n\nArchivo trimestral de [[${slug}|${pageTitle}]].\n\n## 1:1s\n\n` +
          `## See also\n\n- [[${slug}|${pageTitle}]]\n`,
        "utf8"
      );
    }
    addArchiveLink(page, `- [[${archiveFn.replace(/\.md$/, "")}|${label}]]`);
    const archive = parseMarkdownSections(
      fs.readFileSync(archivePath, "utf8").replace(/^updated: .*$/m, `updated: ${today}`)
    );
    mergeEntriesInto(archive, "1:1s", list);
    fs.writeFileSync(archivePath, serializeMarkdownSections(archive), "utf8");
  }
  return serializeMarkdownSections(page);
}

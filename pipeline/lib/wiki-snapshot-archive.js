/**
 * Archivado de "fotos" de estado fechadas de un hub en sus páginas de cronología mensuales.
 */

import fs from "fs";
import path from "path";
import { parseFrontmatter } from "./brain-wiki.js";
import {
  parseMarkdownSections,
  rotateDatedSnapshots,
  serializeMarkdownSections
} from "./wiki-sections.js";

function titleOf(md) {
  const t = parseFrontmatter(md).data.title;
  return t ? String(t) : "";
}

/**
 * Hubs con hijas `<slug>-cronologia-<mes>.md`: las fotos fechadas anteriores
 * (`## Bancos y estado (a 18/10/2026)`…) salen del hub a la cronología de su mes,
 * que se crea si falta y se enlaza en `## Páginas hijas`. El hub conserva la última.
 * Se aplica después de los guards, así que la retención de hechos se mide sin archivar.
 * Escribe las páginas de cronología; devuelve el markdown del hub ya rotado.
 */
export function archiveDatedSnapshots(md, { dirPath, filename, sourcePrefix, today }) {
  const slug = filename.replace(/\.md$/, "");
  const prefix = `${slug}-cronologia-`;
  const siblings = fs.readdirSync(dirPath).filter((f) => f.startsWith(prefix));
  if (siblings.length === 0) return md;
  const { md: rotated, archived } = rotateDatedSnapshots(md);
  if (archived.length === 0) return md;

  const hub = parseMarkdownSections(rotated);
  for (const snap of archived) {
    const childFn = `${prefix}${snap.month}.md`;
    const childPath = path.join(dirPath, childFn);
    if (!fs.existsSync(childPath)) {
      const year = snap.date.slice(0, 4);
      const siblingTitle = titleOf(fs.readFileSync(path.join(dirPath, siblings[0]), "utf8"));
      const title = /\([^)]*\d{4}\)$/.test(siblingTitle)
        ? siblingTitle.replace(/\([^)]*\d{4}\)$/, `(${snap.month} ${year})`)
        : `${titleOf(md) || slug} — cronología (${snap.month} ${year})`;
      fs.writeFileSync(
        childPath,
        `---\ntitle: ${JSON.stringify(title)}\ntype: entity\ncreated: ${today}\nupdated: ${today}\n` +
          `sources:\n  - ${JSON.stringify(`${sourcePrefix}/${filename}`)}\n---\n\n# ${title}\n\n` +
          `Página hija de [[${slug}]]. Fotos de estado archivadas de ${snap.month} de ${year}.\n\n` +
          `## See also\n\n- [[${slug}]]\n`,
        "utf8"
      );
      let idx = hub.sections.findIndex((x) => x.title === "Páginas hijas");
      if (idx < 0) {
        const seeIdx = hub.sections.findIndex((x) => /^(ver también|see also)$/i.test(x.title));
        idx = seeIdx >= 0 ? seeIdx : hub.sections.length;
        hub.sections.splice(idx, 0, { title: "Páginas hijas", body: "## Páginas hijas\n" });
      }
      const body = hub.sections[idx].body.trimEnd();
      const sep = body === "## Páginas hijas" ? "\n\n" : "\n";
      hub.sections[idx].body = `${body}${sep}- [[${childFn.replace(/\.md$/, "")}|${title}]]`;
      siblings.push(childFn);
    }
    const child = parseMarkdownSections(
      fs.readFileSync(childPath, "utf8").replace(/^updated: .*$/m, `updated: ${today}`)
    );
    if (!child.sections.some((x) => x.title === snap.title)) {
      const seeIdx = child.sections.findIndex((x) => /^(ver también|see also)$/i.test(x.title));
      child.sections.splice(seeIdx >= 0 ? seeIdx : child.sections.length, 0, {
        title: snap.title,
        body: snap.body
      });
      fs.writeFileSync(childPath, serializeMarkdownSections(child), "utf8");
    }
    console.log(`  Archivada «${snap.title}» → ${childFn}`);
  }
  return serializeMarkdownSections(hub);
}

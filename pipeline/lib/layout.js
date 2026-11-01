import path from "path";

export function wikiDirName() {
  return process.env.BRAIN_WIKI_DIR_NAME?.trim() || "📒 Wiki";
}

export function inboxDirName() {
  return process.env.INBOX_DIR?.trim() || "📥 Inbox";
}

export function dailyDirName() {
  return process.env.DAILY_NOTES_DIR?.trim() || "🗓️ Daily notes";
}

export function requireVaultPath() {
  const raw = process.env.OBSIDIAN_VAULT_PATH;
  if (!raw || !raw.trim()) {
    console.error("OBSIDIAN_VAULT_PATH is required. Set it to the absolute path of your vault.");
    process.exit(1);
  }
  return path.resolve(raw);
}

export function requireDocsPath(envName) {
  const raw = process.env[envName];
  if (!raw || !raw.trim()) {
    console.error(`${envName} is required.`);
    process.exit(1);
  }
  return path.resolve(raw);
}

/** Prefixes synthesize:wiki will not turn into wiki sources. */
export function excludedPrefixes(wikiName = wikiDirName()) {
  const fromEnv = process.env.WIKI_EXCLUDE_PREFIXES;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [`${wikiName}/`, "🛠️ Resources/", `${inboxDirName()}/`];
}

/** Exceptions inside an excluded prefix. Empty unless WIKI_INCLUDE_PREFIXES is set. */
export function includedPrefixes() {
  const fromEnv = process.env.WIKI_INCLUDE_PREFIXES;
  if (!fromEnv || !fromEnv.trim()) return [];
  return fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
}

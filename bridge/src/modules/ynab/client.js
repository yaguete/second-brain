import { PublicError, UpstreamError } from "../../shared/utils.js";
import { YNAB_TOKEN, YNAB_BASE } from "../../config.js";

export async function ynabFetch(path) {
  if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

  const resp = await fetch(`${YNAB_BASE}${path}`, {
    headers: {
      "Authorization": `Bearer ${YNAB_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!resp.ok) {
    const msg = json?.error?.detail || json?.error?.name || resp.statusText;
    throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
  }

  return json;
}

export async function ynabPost(path, body) {
  if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

  const resp = await fetch(`${YNAB_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${YNAB_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!resp.ok) {
    const msg = json?.error?.detail || json?.error?.name || resp.statusText;
    throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
  }

  return json;
}

export async function ynabPatch(path, body) {
  if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

  const resp = await fetch(`${YNAB_BASE}${path}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${YNAB_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!resp.ok) {
    const msg = json?.error?.detail || json?.error?.name || resp.statusText;
    throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
  }

  return json;
}

export async function ynabPut(path, body) {
  if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

  const resp = await fetch(`${YNAB_BASE}${path}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${YNAB_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!resp.ok) {
    const msg = json?.error?.detail || json?.error?.name || resp.statusText;
    throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
  }

  return json;
}

export async function ynabDelete(path) {
  if (!YNAB_TOKEN) throw new PublicError(500, "not_configured", "YNAB_API_TOKEN not configured");

  const resp = await fetch(`${YNAB_BASE}${path}`, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${YNAB_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!resp.ok) {
    const msg = json?.error?.detail || json?.error?.name || resp.statusText;
    throw new UpstreamError(`YNAB error ${resp.status}: ${msg}`, resp.status);
  }

  return json;
}

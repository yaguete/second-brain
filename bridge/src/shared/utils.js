import crypto from "crypto";

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Cadenas largas sin espacios: base64 de imágenes incrustadas en markdown. */
const BLOB_RE = /[A-Za-z0-9+/]{200,}={0,2}/g;
const DATA_URI_RE = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/**
 * Elimina imágenes base64 / blobs binarios de un markdown.
 * SIEMPRE llamar ANTES de truncar: si truncas primero, el corte se lo come el blob.
 * @param {string} text
 * @returns {{ text: string, removed: number }} removed = chars eliminados
 */
export function stripBinaryBlobs(text) {
  if (!text) return { text: "", removed: 0 };
  if (process.env.STRIP_BINARY_BLOBS === "off") return { text, removed: 0 };
  const before = text.length;
  const out = text
    .replace(DATA_URI_RE, "[imagen incrustada omitida]")
    .replace(BLOB_RE, "[bloque binario omitido]");
  return { text: out, removed: before - out.length };
}

/** Expected client-facing error. `message` is safe to return. */
export class PublicError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/** Upstream failure. The detail is logged; the client only sees upstream_error. */
export class UpstreamError extends Error {
  constructor(detail, status = 502) {
    super(detail || "upstream_error");
    this.status = status;
    this.upstream = true;
  }
}

function requestId() {
  return crypto.randomBytes(8).toString("hex");
}

export function sendError(res, err) {
  if (err instanceof PublicError) {
    if (!res.headersSent) res.status(err.status || 400).json({ error: err.message });
    return;
  }
  const id = requestId();
  console.error(`[${id}]`, err);
  if (res.headersSent) return;
  if (err instanceof UpstreamError) {
    res.status(err.status || 502).json({ error: "upstream_error", id });
    return;
  }
  res.status(500).json({ error: "internal_error", id });
}

export function mcpFail(err) {
  if (err instanceof PublicError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
  }
  const id = requestId();
  console.error(`[${id}]`, err);
  const code = err instanceof UpstreamError ? "upstream_error" : "internal_error";
  return { content: [{ type: "text", text: JSON.stringify({ error: code, id }) }], isError: true };
}

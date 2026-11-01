import crypto from "crypto";

/** Compare two strings without leaking length or prefix. Digests are always 32 bytes. */
export function secretsEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

export function digestToken(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

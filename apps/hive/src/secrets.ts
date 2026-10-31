import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** HIVE_SECRET_KEY: 64 hex chars = a 32-byte AES-256 key. Throws on anything else. */
export function parseSecretKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("HIVE_SECRET_KEY must be 64 hex characters (openssl rand -hex 32)");
  return Buffer.from(hex, "hex");
}

/** AES-256-GCM with a random IV; stored as one blob: iv(12) | tag(16) | ciphertext. */
export function encryptSecret(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** Throws if the key is wrong or the blob was tampered with (GCM auth tag check). */
export function decryptSecret(buf: Buffer, key: Buffer): string {
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("encrypted secret is truncated");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_BYTES));
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

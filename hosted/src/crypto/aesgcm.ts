import { base64ToBytes, bytesToBase64Url, base64UrlToBytes } from "../text";

const IV_BYTES = 12;

export async function encryptString(keyBase64: string, plaintext: string): Promise<string> {
  const key = await importAesKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(cipher))}`;
}

export async function decryptString(keyBase64: string, sealed: string): Promise<string> {
  const [ivPart, cipherPart] = sealed.split(".");
  if (!ivPart || !cipherPart || sealed.split(".").length !== 2) {
    throw new Error("Sealed value is not intact");
  }
  const iv = base64UrlToBytes(ivPart);
  const cipher = base64UrlToBytes(cipherPart);
  if (iv.length !== IV_BYTES || cipher.length < 16) {
    throw new Error("Sealed value is not intact");
  }
  const key = await importAesKey(keyBase64);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Sealed value could not be opened");
  }
}

async function importAesKey(keyBase64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(keyBase64.trim());
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

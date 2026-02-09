import crypto from "crypto";

export function signBody(body: unknown, secret: string): string {
  const payload = JSON.stringify(body);
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifySignature(
  providedSig: string | undefined,
  body: unknown,
  secret: string
): boolean {
  if (!providedSig) return false;
  const expectedSig = signBody(body, secret);
  try {
    const a = Buffer.from(providedSig, "hex");
    const b = Buffer.from(expectedSig, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

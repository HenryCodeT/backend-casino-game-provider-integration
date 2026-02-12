import crypto from "crypto";

export function signBody(body: unknown, secret: string): string {
  const payload = JSON.stringify(body);
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifySignature(
  providedSignature: string | undefined,
  body: unknown,
  secret: string
): boolean {
  if (!providedSignature) return false;
  const expectedSignature = signBody(body, secret);
  try {
    const providedBuffer = Buffer.from(providedSignature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    if (providedBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

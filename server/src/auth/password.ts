import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Cost parameters are written into every hash, so they can be raised later
// without invalidating existing hashes.
const COST = { N: 2 ** 15, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// scrypt needs about 128 * N * r bytes (32 MiB at these parameters), which sits
// right at Node's default limit, so raise the limit explicitly.
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, keylen: number, cost: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC so the same password typed on different keyboards/OSes hashes the same.
    scrypt(password.normalize("NFKC"), salt, keylen, { ...cost, maxmem: MAX_MEM }, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0)) {
    return false;
  }
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  const actual = await derive(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

// For callers with no hash to check (unknown email, GitHub-only user): does the
// same scrypt work as a real check, so response time doesn't reveal which case it was.
export async function verifyPasswordOrDummy(password: string, stored: string | null): Promise<boolean> {
  if (stored !== null) {
    return verifyPassword(password, stored);
  }
  dummyHash ??= hashPassword("tripcord-dummy-password");
  await verifyPassword(password, await dummyHash);
  return false;
}

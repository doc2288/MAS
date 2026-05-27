import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { db, UserRecord } from "./store.js";

const isProduction = process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET;
const DEV_JWT_SECRET = "dev-secret";
if (isProduction && !JWT_SECRET) {
  throw new Error("JWT_SECRET is required when NODE_ENV=production");
}
if (!isProduction && !JWT_SECRET) {
  console.warn("[auth] JWT_SECRET is not set; using an insecure development fallback.");
}
console.warn("[auth] SMS codes are returned in /auth/request responses (no external SMS provider configured).");

const codeTTL = 5 * 60 * 1000;
const maxAttempts = 5;

type PendingCode = {
  phone: string;
  code: string;
  expiresAt: number;
  attempts: number;
};

const pendingCodes = new Map<string, PendingCode>();

setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of pendingCodes) {
    if (entry.expiresAt < now) pendingCodes.delete(phone);
  }
}, 60_000);

export const requestSmsCode = (phone: string) => {
  const code = crypto.randomInt(100000, 1000000).toString();
  pendingCodes.set(phone, {
    phone,
    code,
    expiresAt: Date.now() + codeTTL,
    attempts: 0
  });

  console.log(`[auth] SMS code for ${phone}: ${code}`);

  return { code };
};

export const issueAuthToken = (user: UserRecord) =>
  jwt.sign({ sub: user.id }, JWT_SECRET || DEV_JWT_SECRET, { expiresIn: "7d" });

export const verifySmsCode = (phone: string, code: string) => {
  const pending = pendingCodes.get(phone);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingCodes.delete(phone);
    return null;
  }
  if (pending.code !== code) {
    pending.attempts += 1;
    if (pending.attempts >= maxAttempts) pendingCodes.delete(phone);
    return null;
  }
  pendingCodes.delete(phone);

  let user = db.findUserByPhone(phone);
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      phone,
      createdAt: new Date().toISOString()
    } satisfies UserRecord;
    db.saveUser(user);

    const orphanedIds = db.findOrphanedUserIds();
    for (const oldId of orphanedIds) {
      const migrated = db.migrateMessages(oldId, user.id);
      if (migrated > 0) {
        console.log(`Migrated ${migrated} message(s) from orphaned user ${oldId} to ${user.id}`);
      }
    }
  }

  const token = issueAuthToken(user);
  return { user, token };
};

export const verifyToken = (token: string) => {
  try {
    const payload = jwt.verify(token, JWT_SECRET || DEV_JWT_SECRET) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
};

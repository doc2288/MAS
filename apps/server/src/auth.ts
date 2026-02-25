import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { db, UserRecord } from "./store.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const codeTTL = 5 * 60 * 1000;

type PendingCode = {
  phone: string;
  code: string;
  expiresAt: number;
};

const pendingCodes = new Map<string, PendingCode>();

setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of pendingCodes) {
    if (entry.expiresAt < now) pendingCodes.delete(phone);
  }
}, 60_000);

export const requestSmsCode = (phone: string) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes.set(phone, {
    phone,
    code,
    expiresAt: Date.now() + codeTTL
  });

  return { code };
};

export const verifySmsCode = (phone: string, code: string) => {
  const pending = pendingCodes.get(phone);
  if (!pending || pending.code !== code || pending.expiresAt < Date.now()) {
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

  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "7d" });
  return { user, token };
};

export const verifyToken = (token: string) => {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    return payload.sub;
  } catch {
    return null;
  }
};

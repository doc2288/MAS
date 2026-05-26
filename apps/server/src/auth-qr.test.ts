import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mas-qr-auth-"));
process.env.MAS_DB_PATH = path.join(tmp, "mas.db");

const { db } = await import("./store.js");

const hashSecret = (secret: string) =>
  crypto.createHash("sha256").update(secret).digest("hex");

const saveUser = () => {
  const user = {
    id: crypto.randomUUID(),
    phone: `+1555${crypto.randomInt(1000000, 9999999)}`,
    createdAt: new Date().toISOString(),
  };
  db.saveUser(user);
  return user;
};

const createSession = (secret = crypto.randomUUID(), ttlMs = 120_000) => {
  const createdAt = new Date();
  const session = {
    id: crypto.randomUUID(),
    secretHash: hashSecret(secret),
    status: "pending" as const,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  };
  db.createAuthQrSession(session);
  return { session, secret };
};

test("qr auth approval and claim are single-use", () => {
  const user = saveUser();
  const { session, secret } = createSession();

  const pending = db.getAuthQrSession(session.id, hashSecret(secret));
  assert.equal(pending?.status, "pending");

  const approved = db.approveAuthQrSession(session.id, hashSecret(secret), user.id);
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.approvedByUserId, user.id);

  const claimed = db.claimAuthQrSession(session.id, hashSecret(secret));
  assert.equal(claimed?.status, "claimed");
  assert.equal(claimed?.userId, user.id);

  const duplicate = db.claimAuthQrSession(session.id, hashSecret(secret));
  assert.deepEqual(duplicate, { status: "claimed" });
});

test("qr auth rejects wrong secret and expires unused sessions", () => {
  const user = saveUser();
  const { session, secret } = createSession();

  assert.equal(db.getAuthQrSession(session.id, hashSecret("wrong")), undefined);
  assert.equal(db.approveAuthQrSession(session.id, hashSecret("wrong"), user.id), undefined);

  const expired = db.getAuthQrSession(
    session.id,
    hashSecret(secret),
    new Date(Date.parse(session.expiresAt) + 1).toISOString(),
  );
  assert.equal(expired?.status, "expired");

  const approved = db.approveAuthQrSession(session.id, hashSecret(secret), user.id);
  assert.equal(approved?.status, "expired");
});

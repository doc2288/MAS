import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mas-v2-store-"));
process.env.MAS_DB_PATH = path.join(tmp, "mas.db");

const { db } = await import("./store.js");

const now = () => new Date().toISOString();

const saveUser = (phone: string) => {
  const user = { id: crypto.randomUUID(), phone, createdAt: now() };
  db.saveUser(user);
  return user;
};

const saveDevice = (userId: string, label: string) => {
  const at = now();
  const device = {
    id: crypto.randomUUID(),
    userId,
    label,
    identityKey: `identity-${label}`,
    registrationId: Math.floor(Math.random() * 1_000_000) + 1,
    signedPreKeyId: 1,
    signedPreKeyPublic: `signed-public-${label}`,
    signedPreKeySignature: `signed-signature-${label}`,
    status: "active" as const,
    createdAt: at,
    updatedAt: at,
    lastSeenAt: at,
  };
  db.saveDevice(device);
  return device;
};

test("v2 prekey bundles, envelope sync, ack, and idempotency", () => {
  const alice = saveUser("+15550000001");
  const bob = saveUser("+15550000002");
  const aliceDevice = saveDevice(alice.id, "alice-web");
  const bobPhone = saveDevice(bob.id, "bob-phone");
  const bobDesktop = saveDevice(bob.id, "bob-desktop");

  db.saveOneTimePreKeys(bobPhone.id, [{ keyId: 10, publicKey: "bob-phone-otk-10" }]);
  db.saveOneTimePreKeys(bobDesktop.id, [{ keyId: 20, publicKey: "bob-desktop-otk-20" }]);

  const bundles = db.claimPreKeyBundles([bob.id], aliceDevice.id);
  assert.equal(bundles.length, 2);
  assert.deepEqual(
    bundles.map((bundle) => bundle.oneTimePreKey?.keyId).sort((a, b) => (a ?? 0) - (b ?? 0)),
    [10, 20],
  );

  const secondClaim = db.claimPreKeyBundles([bob.id], aliceDevice.id);
  assert.equal(secondClaim.length, 2);
  assert.equal(secondClaim.some((bundle) => bundle.oneTimePreKey), false);

  const clientMessageId = crypto.randomUUID();
  const message = {
    id: crypto.randomUUID(),
    clientMessageId,
    senderUserId: alice.id,
    senderDeviceId: aliceDevice.id,
    conversationId: [alice.id, bob.id].sort().join(":"),
    contentType: "text" as const,
    createdAt: now(),
    serverReceivedAt: now(),
  };
  const saved = db.saveV2Message({
    message,
    envelopes: [
      {
        id: crypto.randomUUID(),
        recipientUserId: bob.id,
        recipientDeviceId: bobPhone.id,
        envelopeType: "prekey",
        ciphertext: "ciphertext-phone",
        preKeyId: 10,
      },
      {
        id: crypto.randomUUID(),
        recipientUserId: bob.id,
        recipientDeviceId: bobDesktop.id,
        envelopeType: "prekey",
        ciphertext: "ciphertext-desktop",
        preKeyId: 20,
      },
    ],
  });

  assert.equal(saved.length, 2);
  assert.equal(saved[0].deviceSeq, 1);
  assert.equal(saved[1].deviceSeq, 1);

  const duplicate = db.saveV2Message({
    message: { ...message, id: crypto.randomUUID() },
    envelopes: [],
  });
  assert.equal(duplicate.length, 2);
  assert.deepEqual(duplicate.map((item) => item.id).sort(), saved.map((item) => item.id).sort());

  const phoneSync = db.getV2SyncEnvelopes(bob.id, bobPhone.id, 0);
  assert.equal(phoneSync.length, 1);
  assert.equal(phoneSync[0].ciphertext, "ciphertext-phone");

  const ack = db.ackV2Envelopes(bob.id, bobPhone.id, [phoneSync[0].id], [phoneSync[0].id]);
  assert.deepEqual(ack.deliveredIds, [phoneSync[0].id]);
  assert.deepEqual(ack.readIds, [phoneSync[0].id]);
  assert.equal(ack.lastAckSeq, 1);

  const retry = db.requestV2Retry(bob.id, bobDesktop.id, saved[1].id);
  assert.equal(retry?.envelopeId, saved[1].id);
});

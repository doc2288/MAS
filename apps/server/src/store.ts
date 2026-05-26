import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const dataDir = process.env.MAS_DATA_DIR ?? path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(process.env.MAS_DB_PATH ?? path.join(dataDir, "mas.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    login TEXT,
    publicKey TEXT,
    secretKey TEXT,
    status TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    contentType TEXT NOT NULL DEFAULT 'text',
    body TEXT,
    meta TEXT,
    nonce TEXT,
    ciphertext TEXT,
    selfNonce TEXT,
    selfCiphertext TEXT,
    senderPublicKey TEXT,
    deliveredAt TEXT,
    readAt TEXT,
    editedAt TEXT,
    replyToId TEXT,
    pinned INTEGER DEFAULT 0,
    reactions TEXT
  );
  CREATE TABLE IF NOT EXISTS key_backups (
    userId TEXT PRIMARY KEY,
    publicKey TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    salt TEXT NOT NULL,
    nonce TEXT NOT NULL,
    kdf TEXT NOT NULL,
    iterations INTEGER NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    peerId TEXT NOT NULL,
    filename TEXT NOT NULL,
    originalName TEXT NOT NULL,
    mimeType TEXT,
    size INTEGER NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS message_deletions (
    messageId TEXT NOT NULL,
    userId TEXT NOT NULL,
    hiddenAt TEXT NOT NULL,
    PRIMARY KEY (messageId, userId)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_from ON messages("from");
  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to");
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages("from", "to", createdAt);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(createdAt);
  CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  CREATE INDEX IF NOT EXISTS idx_users_login ON users(login);
  CREATE INDEX IF NOT EXISTS idx_files_owner ON files(ownerId);
  CREATE INDEX IF NOT EXISTS idx_files_peer ON files(peerId);
  CREATE INDEX IF NOT EXISTS idx_message_deletions_user ON message_deletions(userId);
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    label TEXT,
    identityKey TEXT NOT NULL,
    registrationId INTEGER NOT NULL,
    signedPreKeyId INTEGER NOT NULL,
    signedPreKeyPublic TEXT NOT NULL,
    signedPreKeySignature TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastSeenAt TEXT,
    UNIQUE(userId, id),
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS one_time_prekeys (
    deviceId TEXT NOT NULL,
    keyId INTEGER NOT NULL,
    publicKey TEXT NOT NULL,
    claimedAt TEXT,
    createdAt TEXT NOT NULL,
    PRIMARY KEY(deviceId, keyId),
    FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS messages_v2 (
    id TEXT PRIMARY KEY,
    clientMessageId TEXT NOT NULL,
    senderUserId TEXT NOT NULL,
    senderDeviceId TEXT NOT NULL,
    conversationId TEXT NOT NULL,
    contentType TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    serverReceivedAt TEXT NOT NULL,
    UNIQUE(senderUserId, senderDeviceId, clientMessageId),
    FOREIGN KEY(senderUserId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(senderDeviceId) REFERENCES devices(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS message_envelopes (
    id TEXT PRIMARY KEY,
    messageId TEXT NOT NULL,
    recipientUserId TEXT NOT NULL,
    recipientDeviceId TEXT NOT NULL,
    senderUserId TEXT NOT NULL,
    senderDeviceId TEXT NOT NULL,
    deviceSeq INTEGER NOT NULL,
    envelopeType TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    sessionId TEXT,
    preKeyId INTEGER,
    createdAt TEXT NOT NULL,
    deliveredAt TEXT,
    readAt TEXT,
    retryRequestedAt TEXT,
    retryCount INTEGER NOT NULL DEFAULT 0,
    UNIQUE(recipientDeviceId, deviceSeq),
    FOREIGN KEY(messageId) REFERENCES messages_v2(id) ON DELETE CASCADE,
    FOREIGN KEY(recipientUserId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(recipientDeviceId) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY(senderUserId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(senderDeviceId) REFERENCES devices(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS device_sync_state (
    deviceId TEXT PRIMARY KEY,
    lastAckSeq INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(userId);
  CREATE INDEX IF NOT EXISTS idx_prekeys_device_claimed ON one_time_prekeys(deviceId, claimedAt);
  CREATE INDEX IF NOT EXISTS idx_messages_v2_sender_client ON messages_v2(senderUserId, senderDeviceId, clientMessageId);
  CREATE INDEX IF NOT EXISTS idx_messages_v2_conversation ON messages_v2(conversationId, serverReceivedAt);
  CREATE INDEX IF NOT EXISTS idx_envelopes_recipient_seq ON message_envelopes(recipientDeviceId, deviceSeq);
  CREATE INDEX IF NOT EXISTS idx_envelopes_message ON message_envelopes(messageId);
  CREATE INDEX IF NOT EXISTS idx_envelopes_sender ON message_envelopes(senderUserId, senderDeviceId);
  CREATE TABLE IF NOT EXISTS auth_qr_sessions (
    id TEXT PRIMARY KEY,
    secretHash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    approvedByUserId TEXT,
    approvedAt TEXT,
    claimedAt TEXT,
    FOREIGN KEY(approvedByUserId) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_qr_sessions_status ON auth_qr_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_auth_qr_sessions_expires ON auth_qr_sessions(expiresAt);
`);

sqlite.exec(`UPDATE users SET secretKey = NULL WHERE secretKey IS NOT NULL`);

export type UserRecord = {
  id: string;
  phone: string;
  login?: string | null;
  publicKey?: string | null;
  secretKey?: string | null;
  status?: string | null;
  createdAt: string;
};

export type PublicUser = {
  id: string;
  phone: string;
  login?: string;
  publicKey?: string;
  status?: string;
  createdAt?: string;
};

export type MessageRecord = {
  id: string;
  from: string;
  to: string;
  createdAt: string;
  contentType: "text" | "file" | "emoji" | "sticker" | "gif" | "call" | "voice";
  body?: string;
  meta?: Record<string, string>;
  nonce?: string;
  ciphertext?: string;
  selfNonce?: string;
  selfCiphertext?: string;
  senderPublicKey?: string;
  deliveredAt?: string;
  readAt?: string;
  editedAt?: string;
  replyToId?: string;
  pinned?: boolean;
  reactions?: Record<string, string[]>;
};

export type ChatSummary = {
  peerId: string;
  peerPhone: string;
  peerLogin?: string;
  peerPublicKey?: string;
  lastMessageAt: string;
  lastContentType: string;
};

export type KeyBackupRecord = {
  userId: string;
  publicKey: string;
  ciphertext: string;
  salt: string;
  nonce: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  updatedAt: string;
};

export type StoredFileRecord = {
  id: string;
  ownerId: string;
  peerId: string;
  filename: string;
  originalName: string;
  mimeType?: string | null;
  size: number;
  createdAt: string;
};

export type DeviceRecord = {
  id: string;
  userId: string;
  label?: string | null;
  identityKey: string;
  registrationId: number;
  signedPreKeyId: number;
  signedPreKeyPublic: string;
  signedPreKeySignature: string;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string | null;
};

export type PublicDeviceBundle = {
  userId: string;
  deviceId: string;
  identityKey: string;
  registrationId: number;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  oneTimePreKey?: {
    keyId: number;
    publicKey: string;
  };
};

export type PreKeyRecord = {
  deviceId: string;
  keyId: number;
  publicKey: string;
  claimedAt?: string | null;
  createdAt: string;
};

export type V2ContentType = "text" | "file" | "emoji" | "sticker" | "gif" | "call" | "voice";

export type V2MessageRecord = {
  id: string;
  clientMessageId: string;
  senderUserId: string;
  senderDeviceId: string;
  conversationId: string;
  contentType: V2ContentType;
  createdAt: string;
  serverReceivedAt: string;
};

export type V2EnvelopeInput = {
  id: string;
  recipientUserId: string;
  recipientDeviceId: string;
  envelopeType: "prekey" | "signal" | "retry";
  ciphertext: string;
  sessionId?: string;
  preKeyId?: number;
};

export type V2EnvelopeRecord = V2EnvelopeInput & {
  messageId: string;
  senderUserId: string;
  senderDeviceId: string;
  deviceSeq: number;
  createdAt: string;
  deliveredAt?: string | null;
  readAt?: string | null;
  retryRequestedAt?: string | null;
  retryCount: number;
};

export type SaveV2MessageInput = {
  message: V2MessageRecord;
  envelopes: V2EnvelopeInput[];
};

export type AuthQrStatus = "pending" | "approved" | "claimed" | "denied" | "expired";

export type AuthQrSessionRecord = {
  id: string;
  secretHash: string;
  status: AuthQrStatus;
  createdAt: string;
  expiresAt: string;
  approvedByUserId?: string | null;
  approvedAt?: string | null;
  claimedAt?: string | null;
};

export type AuthQrClaimResult =
  | { status: "claimed"; userId: string; claimedAt: string }
  | { status: AuthQrStatus; userId?: undefined; claimedAt?: undefined }
  | null;

const stmts = {
  upsertUser: sqlite.prepare(`
    INSERT INTO users (id, phone, login, publicKey, secretKey, status, createdAt)
    VALUES (@id, @phone, @login, @publicKey, NULL, @status, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      phone=@phone, login=@login, publicKey=@publicKey, secretKey=NULL, status=@status
  `),
  findUserById: sqlite.prepare(`SELECT * FROM users WHERE id = ?`),
  findUserByPhone: sqlite.prepare(`SELECT * FROM users WHERE phone = ?`),
  findUserByLogin: sqlite.prepare(`SELECT * FROM users WHERE login = ?`),
  searchByLoginPrefix: sqlite.prepare(`SELECT * FROM users WHERE login LIKE ? AND id != ? LIMIT 20`),
  isLoginTaken: sqlite.prepare(`SELECT 1 FROM users WHERE login = ? AND id != ?`),
  insertMessage: sqlite.prepare(`
    INSERT INTO messages (id, "from", "to", createdAt, contentType, body, meta, nonce, ciphertext,
      selfNonce, selfCiphertext, senderPublicKey, deliveredAt, readAt, editedAt, replyToId, pinned, reactions)
    VALUES (@id, @from, @to, @createdAt, @contentType, @body, @meta, @nonce, @ciphertext,
      @selfNonce, @selfCiphertext, @senderPublicKey, @deliveredAt, @readAt, @editedAt, @replyToId, @pinned, @reactions)
  `),
  paginatedMessages: sqlite.prepare(`
    SELECT m.* FROM messages m
    LEFT JOIN message_deletions d ON d.messageId = m.id AND d.userId = @userId
    WHERE d.messageId IS NULL
      AND ((m."from" = @userId AND m."to" = @peerId) OR (m."from" = @peerId AND m."to" = @userId))
    ORDER BY m.createdAt DESC, m.rowid DESC LIMIT @limit OFFSET @offset
  `),
  chatList: sqlite.prepare(`
    WITH visible AS (
      SELECT m.rowid, m."from", m."to", m.createdAt, m.contentType
      FROM messages m
      LEFT JOIN message_deletions d ON d.messageId = m.id AND d.userId = @uid
      WHERE d.messageId IS NULL AND (m."from" = @uid OR m."to" = @uid)
    ),
    peers AS (
      SELECT CASE WHEN "from" = @uid THEN "to" ELSE "from" END AS peerId, MAX(rowid) AS lastRowid
      FROM visible
      GROUP BY peerId
    )
    SELECT p.peerId, v.createdAt AS lastMessageAt, v.contentType AS lastContentType
    FROM peers p
    JOIN visible v ON v.rowid = p.lastRowid
    ORDER BY v.createdAt DESC
    LIMIT 50
  `),
  getMessage: sqlite.prepare(`SELECT * FROM messages WHERE id = ?`),
  getMessageInConversation: sqlite.prepare(`
    SELECT * FROM messages
    WHERE id = @id
      AND (("from" = @userId AND "to" = @peerId) OR ("from" = @peerId AND "to" = @userId))
  `),
  deleteOwnMessageForEveryone: sqlite.prepare(`DELETE FROM messages WHERE id = ? AND "from" = ? AND "to" = ?`),
  deleteMessageDeletions: sqlite.prepare(`DELETE FROM message_deletions WHERE messageId = ?`),
  hideConversation: sqlite.prepare(`
    INSERT OR IGNORE INTO message_deletions (messageId, userId, hiddenAt)
    SELECT id, @userId, @hiddenAt FROM messages
    WHERE ("from" = @userId AND "to" = @peerId) OR ("from" = @peerId AND "to" = @userId)
  `),
  deleteHiddenForConversation: sqlite.prepare(`
    DELETE FROM message_deletions WHERE messageId IN (
      SELECT id FROM messages
      WHERE ("from" = @userId AND "to" = @peerId) OR ("from" = @peerId AND "to" = @userId)
    )
  `),
  deleteConversation: sqlite.prepare(`
    DELETE FROM messages WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)
  `),
  updateDelivered: sqlite.prepare(
    `UPDATE messages SET deliveredAt = COALESCE(@deliveredAt, deliveredAt), readAt = COALESCE(@readAt, readAt) WHERE id = @id`
  ),
  editMessage: sqlite.prepare(`
    UPDATE messages SET ciphertext=@ciphertext, nonce=@nonce, selfCiphertext=@selfCiphertext,
      selfNonce=@selfNonce, senderPublicKey=@senderPublicKey, editedAt=@editedAt
    WHERE id = @id AND "from" = @userId AND "to" = @peerId
  `),
  togglePin: sqlite.prepare(`
    UPDATE messages SET pinned = NOT pinned
    WHERE id = @id
      AND (("from" = @userId AND "to" = @peerId) OR ("from" = @peerId AND "to" = @userId))
  `),
  updateReactions: sqlite.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`),
  upsertBackup: sqlite.prepare(`
    INSERT INTO key_backups (userId, publicKey, ciphertext, salt, nonce, kdf, iterations, updatedAt)
    VALUES (@userId, @publicKey, @ciphertext, @salt, @nonce, @kdf, @iterations, @updatedAt)
    ON CONFLICT(userId) DO UPDATE SET
      publicKey=@publicKey, ciphertext=@ciphertext, salt=@salt, nonce=@nonce,
      kdf=@kdf, iterations=@iterations, updatedAt=@updatedAt
  `),
  getBackup: sqlite.prepare(`SELECT * FROM key_backups WHERE userId = ?`),
  insertAuthQrSession: sqlite.prepare(`
    INSERT INTO auth_qr_sessions (id, secretHash, status, createdAt, expiresAt, approvedByUserId, approvedAt, claimedAt)
    VALUES (@id, @secretHash, @status, @createdAt, @expiresAt, NULL, NULL, NULL)
  `),
  findAuthQrSession: sqlite.prepare(`SELECT * FROM auth_qr_sessions WHERE id = ?`),
  expireAuthQrSession: sqlite.prepare(`
    UPDATE auth_qr_sessions
    SET status = 'expired'
    WHERE id = @id
      AND secretHash = @secretHash
      AND status IN ('pending', 'approved')
      AND claimedAt IS NULL
      AND expiresAt <= @now
  `),
  approveAuthQrSession: sqlite.prepare(`
    UPDATE auth_qr_sessions
    SET status = 'approved', approvedByUserId = @userId, approvedAt = @approvedAt
    WHERE id = @id
      AND secretHash = @secretHash
      AND status = 'pending'
      AND expiresAt > @approvedAt
  `),
  claimAuthQrSession: sqlite.prepare(`
    UPDATE auth_qr_sessions
    SET status = 'claimed', claimedAt = @claimedAt
    WHERE id = @id
      AND secretHash = @secretHash
      AND status = 'approved'
      AND approvedByUserId IS NOT NULL
      AND claimedAt IS NULL
      AND expiresAt > @claimedAt
  `),
  insertFile: sqlite.prepare(`
    INSERT INTO files (id, ownerId, peerId, filename, originalName, mimeType, size, createdAt)
    VALUES (@id, @ownerId, @peerId, @filename, @originalName, @mimeType, @size, @createdAt)
  `),
  findFileById: sqlite.prepare(`SELECT * FROM files WHERE id = ?`),
  findFileForUser: sqlite.prepare(`SELECT * FROM files WHERE id = ? AND (ownerId = ? OR peerId = ?)`),
  upsertDevice: sqlite.prepare(`
    INSERT INTO devices (id, userId, label, identityKey, registrationId, signedPreKeyId,
      signedPreKeyPublic, signedPreKeySignature, status, createdAt, updatedAt, lastSeenAt)
    VALUES (@id, @userId, @label, @identityKey, @registrationId, @signedPreKeyId,
      @signedPreKeyPublic, @signedPreKeySignature, @status, @createdAt, @updatedAt, @lastSeenAt)
    ON CONFLICT(id) DO UPDATE SET
      label=@label,
      identityKey=@identityKey,
      registrationId=@registrationId,
      signedPreKeyId=@signedPreKeyId,
      signedPreKeyPublic=@signedPreKeyPublic,
      signedPreKeySignature=@signedPreKeySignature,
      status=@status,
      updatedAt=@updatedAt,
      lastSeenAt=COALESCE(@lastSeenAt, lastSeenAt)
    WHERE devices.userId = @userId
  `),
  findDeviceById: sqlite.prepare(`SELECT * FROM devices WHERE id = ?`),
  findDeviceForUser: sqlite.prepare(`SELECT * FROM devices WHERE id = ? AND userId = ?`),
  activeDevicesForUser: sqlite.prepare(`SELECT * FROM devices WHERE userId = ? AND status = 'active' ORDER BY createdAt ASC`),
  touchDevice: sqlite.prepare(`UPDATE devices SET lastSeenAt = @lastSeenAt, updatedAt = @lastSeenAt WHERE id = @deviceId AND userId = @userId`),
  upsertPreKey: sqlite.prepare(`
    INSERT INTO one_time_prekeys (deviceId, keyId, publicKey, claimedAt, createdAt)
    VALUES (@deviceId, @keyId, @publicKey, NULL, @createdAt)
    ON CONFLICT(deviceId, keyId) DO UPDATE SET
      publicKey=@publicKey,
      claimedAt=NULL
  `),
  availablePreKeyForDevice: sqlite.prepare(`
    SELECT * FROM one_time_prekeys
    WHERE deviceId = ? AND claimedAt IS NULL
    ORDER BY keyId ASC
    LIMIT 1
  `),
  claimPreKey: sqlite.prepare(`
    UPDATE one_time_prekeys SET claimedAt = ?
    WHERE deviceId = ? AND keyId = ? AND claimedAt IS NULL
  `),
  insertV2Message: sqlite.prepare(`
    INSERT INTO messages_v2 (id, clientMessageId, senderUserId, senderDeviceId, conversationId,
      contentType, createdAt, serverReceivedAt)
    VALUES (@id, @clientMessageId, @senderUserId, @senderDeviceId, @conversationId,
      @contentType, @createdAt, @serverReceivedAt)
  `),
  findV2MessageByClientId: sqlite.prepare(`
    SELECT * FROM messages_v2
    WHERE senderUserId = ? AND senderDeviceId = ? AND clientMessageId = ?
  `),
  nextEnvelopeSeq: sqlite.prepare(`SELECT COALESCE(MAX(deviceSeq), 0) + 1 AS nextSeq FROM message_envelopes WHERE recipientDeviceId = ?`),
  insertEnvelope: sqlite.prepare(`
    INSERT INTO message_envelopes (id, messageId, recipientUserId, recipientDeviceId, senderUserId,
      senderDeviceId, deviceSeq, envelopeType, ciphertext, sessionId, preKeyId, createdAt,
      deliveredAt, readAt, retryRequestedAt, retryCount)
    VALUES (@id, @messageId, @recipientUserId, @recipientDeviceId, @senderUserId,
      @senderDeviceId, @deviceSeq, @envelopeType, @ciphertext, @sessionId, @preKeyId, @createdAt,
      NULL, NULL, NULL, 0)
  `),
  syncEnvelopesForDevice: sqlite.prepare(`
    SELECT * FROM message_envelopes
    WHERE recipientDeviceId = @deviceId AND deviceSeq > @afterSeq
    ORDER BY deviceSeq ASC
    LIMIT @limit
  `),
  markEnvelopeDelivered: sqlite.prepare(`
    UPDATE message_envelopes
    SET deliveredAt = COALESCE(deliveredAt, @deliveredAt)
    WHERE id = @id AND recipientUserId = @userId AND recipientDeviceId = @deviceId
  `),
  markEnvelopeRead: sqlite.prepare(`
    UPDATE message_envelopes
    SET deliveredAt = COALESCE(deliveredAt, @readAt), readAt = COALESCE(readAt, @readAt)
    WHERE id = @id AND recipientUserId = @userId AND recipientDeviceId = @deviceId
  `),
  upsertSyncState: sqlite.prepare(`
    INSERT INTO device_sync_state (deviceId, lastAckSeq, updatedAt)
    VALUES (@deviceId, @lastAckSeq, @updatedAt)
    ON CONFLICT(deviceId) DO UPDATE SET
      lastAckSeq = MAX(lastAckSeq, @lastAckSeq),
      updatedAt = @updatedAt
  `),
  requestEnvelopeRetry: sqlite.prepare(`
    UPDATE message_envelopes
    SET retryRequestedAt = @retryRequestedAt, retryCount = retryCount + 1
    WHERE id = @id AND recipientUserId = @userId AND recipientDeviceId = @deviceId AND retryCount < 3
  `),
  envelopesByMessage: sqlite.prepare(`SELECT * FROM message_envelopes WHERE messageId = ?`),
  envelopesByIds: sqlite.prepare(`SELECT * FROM message_envelopes WHERE id = ?`),
  migrateFrom: sqlite.prepare(`UPDATE messages SET "from" = ? WHERE "from" = ?`),
  migrateTo: sqlite.prepare(`UPDATE messages SET "to" = ? WHERE "to" = ?`),
  orphanedUserIds: sqlite.prepare(`
    SELECT DISTINCT u FROM (
      SELECT "from" AS u FROM messages UNION SELECT "to" AS u FROM messages
    ) WHERE u NOT IN (SELECT id FROM users)
  `),
};

const parseJson = <T>(value: string | null | undefined): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const toRow = (msg: MessageRecord) => ({
  id: msg.id,
  from: msg.from,
  to: msg.to,
  createdAt: msg.createdAt,
  contentType: msg.contentType ?? "text",
  body: msg.body ?? null,
  meta: msg.meta ? JSON.stringify(msg.meta) : null,
  nonce: msg.nonce ?? null,
  ciphertext: msg.ciphertext ?? null,
  selfNonce: msg.selfNonce ?? null,
  selfCiphertext: msg.selfCiphertext ?? null,
  senderPublicKey: msg.senderPublicKey ?? null,
  deliveredAt: msg.deliveredAt ?? null,
  readAt: msg.readAt ?? null,
  editedAt: msg.editedAt ?? null,
  replyToId: msg.replyToId ?? null,
  pinned: msg.pinned ? 1 : 0,
  reactions: msg.reactions ? JSON.stringify(msg.reactions) : null,
});

const fromRow = (row: unknown): MessageRecord | undefined => {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  return {
    ...(r as unknown as MessageRecord),
    meta: parseJson<Record<string, string>>(r.meta as string | null),
    reactions: parseJson<Record<string, string[]>>(r.reactions as string | null),
    pinned: r.pinned === 1,
  };
};

const batchUpdateDelivered = sqlite.transaction((ids: string[], deliveredAt: string | null, readAt: string | null) => {
  for (const id of ids) stmts.updateDelivered.run({ id, deliveredAt, readAt });
});

const deleteOwnMessageTx = sqlite.transaction((id: string, userId: string, peerId: string) => {
  const deleted = stmts.deleteOwnMessageForEveryone.run(id, userId, peerId).changes;
  if (deleted > 0) stmts.deleteMessageDeletions.run(id);
  return deleted > 0;
});

const deleteConversationBothTx = sqlite.transaction((userId: string, peerId: string) => {
  stmts.deleteHiddenForConversation.run({ userId, peerId });
  return stmts.deleteConversation.run(userId, peerId, peerId, userId).changes;
});

const transactReaction = sqlite.transaction((id: string, userId: string, peerId: string, emoji: string) => {
  const row = fromRow(stmts.getMessageInConversation.get({ id, userId, peerId }));
  if (!row) return null;
  const reactions: Record<string, string[]> = row.reactions ?? {};
  if (!reactions[emoji]) reactions[emoji] = [];
  const idx = reactions[emoji].indexOf(userId);
  if (idx >= 0) {
    reactions[emoji].splice(idx, 1);
    if (!reactions[emoji].length) delete reactions[emoji];
  } else {
    reactions[emoji].push(userId);
  }
  stmts.updateReactions.run(JSON.stringify(reactions), id);
  return { ...row, reactions };
});

const claimPreKeyForDeviceTx = sqlite.transaction((device: DeviceRecord): PublicDeviceBundle => {
  const now = new Date().toISOString();
  const preKey = stmts.availablePreKeyForDevice.get(device.id) as PreKeyRecord | undefined;
  if (preKey) {
    const claimed = stmts.claimPreKey.run(now, device.id, preKey.keyId).changes > 0;
    if (!claimed) {
      return claimPreKeyForDeviceTx(device);
    }
  }
  return {
    userId: device.userId,
    deviceId: device.id,
    identityKey: device.identityKey,
    registrationId: device.registrationId,
    signedPreKey: {
      keyId: device.signedPreKeyId,
      publicKey: device.signedPreKeyPublic,
      signature: device.signedPreKeySignature,
    },
    ...(preKey ? { oneTimePreKey: { keyId: preKey.keyId, publicKey: preKey.publicKey } } : {}),
  };
});

const saveV2MessageTx = sqlite.transaction((input: SaveV2MessageInput): V2EnvelopeRecord[] => {
  const existing = stmts.findV2MessageByClientId.get(
    input.message.senderUserId,
    input.message.senderDeviceId,
    input.message.clientMessageId
  ) as V2MessageRecord | undefined;
  if (existing) {
    return stmts.envelopesByMessage.all(existing.id) as V2EnvelopeRecord[];
  }

  stmts.insertV2Message.run(input.message);
  const created: V2EnvelopeRecord[] = [];
  for (const envelope of input.envelopes) {
    const next = stmts.nextEnvelopeSeq.get(envelope.recipientDeviceId) as { nextSeq: number };
    const row: V2EnvelopeRecord = {
      ...envelope,
      messageId: input.message.id,
      senderUserId: input.message.senderUserId,
      senderDeviceId: input.message.senderDeviceId,
      deviceSeq: next.nextSeq,
      createdAt: input.message.serverReceivedAt,
      retryCount: 0,
    };
    stmts.insertEnvelope.run({
      ...row,
      sessionId: row.sessionId ?? null,
      preKeyId: row.preKeyId ?? null,
    });
    created.push(row);
  }
  return created;
});

const ackV2EnvelopesTx = sqlite.transaction((
  userId: string,
  deviceId: string,
  envelopeIds: string[],
  readEnvelopeIds: string[],
) => {
  const now = new Date().toISOString();
  let maxSeq = 0;
  const delivered = new Set<string>();
  const read = new Set<string>();
  for (const id of [...new Set(envelopeIds)]) {
    const result = stmts.markEnvelopeDelivered.run({ id, userId, deviceId, deliveredAt: now });
    if (result.changes > 0) delivered.add(id);
  }
  for (const id of [...new Set(readEnvelopeIds)]) {
    const result = stmts.markEnvelopeRead.run({ id, userId, deviceId, readAt: now });
    if (result.changes > 0) read.add(id);
  }
  const rows = sqlite
    .prepare(`SELECT id, deviceSeq FROM message_envelopes WHERE recipientUserId = ? AND recipientDeviceId = ? AND id IN (${[...delivered, ...read].map(() => "?").join(",") || "NULL"})`)
    .all(userId, deviceId, ...[...delivered, ...read]) as { id: string; deviceSeq: number }[];
  for (const row of rows) maxSeq = Math.max(maxSeq, row.deviceSeq);
  if (maxSeq > 0) {
    stmts.upsertSyncState.run({ deviceId, lastAckSeq: maxSeq, updatedAt: now });
  }
  return { deliveredIds: [...delivered], readIds: [...read], at: now, lastAckSeq: maxSeq };
});

const readAuthQrSession = (id: string): AuthQrSessionRecord | undefined =>
  stmts.findAuthQrSession.get(id) as AuthQrSessionRecord | undefined;

const refreshAuthQrSession = (id: string, secretHash: string, now: string): AuthQrSessionRecord | undefined => {
  stmts.expireAuthQrSession.run({ id, secretHash, now });
  const row = readAuthQrSession(id);
  if (!row || row.secretHash !== secretHash) return undefined;
  return row;
};

const approveAuthQrSessionTx = sqlite.transaction((
  id: string,
  secretHash: string,
  userId: string,
  approvedAt: string,
): AuthQrSessionRecord | undefined => {
  const current = refreshAuthQrSession(id, secretHash, approvedAt);
  if (!current || current.status !== "pending") return current;
  stmts.approveAuthQrSession.run({ id, secretHash, userId, approvedAt });
  return readAuthQrSession(id);
});

const claimAuthQrSessionTx = sqlite.transaction((
  id: string,
  secretHash: string,
  claimedAt: string,
): AuthQrClaimResult => {
  const current = refreshAuthQrSession(id, secretHash, claimedAt);
  if (!current) return null;
  if (current.status !== "approved" || !current.approvedByUserId) {
    return { status: current.status };
  }
  const result = stmts.claimAuthQrSession.run({ id, secretHash, claimedAt });
  if (result.changes === 0) {
    const latest = readAuthQrSession(id);
    return latest ? { status: latest.status } : null;
  }
  return { status: "claimed", userId: current.approvedByUserId, claimedAt };
});

export const toPublicUser = (user: UserRecord, includeCreatedAt = false): PublicUser => ({
  id: user.id,
  phone: user.phone,
  ...(user.login ? { login: user.login } : {}),
  ...(user.publicKey ? { publicKey: user.publicKey } : {}),
  ...(user.status ? { status: user.status } : {}),
  ...(includeCreatedAt ? { createdAt: user.createdAt } : {}),
});

export const db = {
  getUsers(): UserRecord[] {
    return sqlite.prepare(`SELECT * FROM users`).all() as UserRecord[];
  },
  saveUser(user: UserRecord) {
    stmts.upsertUser.run({
      id: user.id,
      phone: user.phone,
      login: user.login ?? null,
      publicKey: user.publicKey ?? null,
      status: user.status ?? null,
      createdAt: user.createdAt,
    });
  },
  findUserByPhone(phone: string): UserRecord | undefined {
    return stmts.findUserByPhone.get(phone) as UserRecord | undefined;
  },
  findUserById(id: string): UserRecord | undefined {
    return stmts.findUserById.get(id) as UserRecord | undefined;
  },
  findUserByLogin(login: string): UserRecord | undefined {
    return stmts.findUserByLogin.get(login) as UserRecord | undefined;
  },
  searchUsersByLoginPrefix(prefix: string, excludeUserId?: string): UserRecord[] {
    return stmts.searchByLoginPrefix.all(`${prefix}%`, excludeUserId ?? "") as UserRecord[];
  },
  isLoginTaken(login: string, excludeUserId?: string): boolean {
    return !!stmts.isLoginTaken.get(login, excludeUserId ?? "");
  },
  saveMessage(message: MessageRecord) {
    stmts.insertMessage.run(toRow(message));
  },
  getMessageInConversation(id: string, userId: string, peerId: string): MessageRecord | undefined {
    return fromRow(stmts.getMessageInConversation.get({ id, userId, peerId }));
  },
  editMessage(id: string, userId: string, peerId: string, patch: Partial<MessageRecord>) {
    const editedAt = new Date().toISOString();
    const result = stmts.editMessage.run({
      id,
      userId,
      peerId,
      ciphertext: patch.ciphertext ?? null,
      nonce: patch.nonce ?? null,
      selfCiphertext: patch.selfCiphertext ?? null,
      selfNonce: patch.selfNonce ?? null,
      senderPublicKey: patch.senderPublicKey ?? null,
      editedAt,
    });
    if (result.changes === 0) return null;
    return fromRow(stmts.getMessage.get(id));
  },
  togglePin(id: string, userId: string, peerId: string) {
    const result = stmts.togglePin.run({ id, userId, peerId });
    if (result.changes === 0) return null;
    return fromRow(stmts.getMessage.get(id));
  },
  addReaction(id: string, userId: string, peerId: string, emoji: string) {
    return transactReaction(id, userId, peerId, emoji);
  },
  updateMessages(ids: string[], patch: Partial<MessageRecord>) {
    batchUpdateDelivered(ids, patch.deliveredAt ?? null, patch.readAt ?? null);
  },
  markMessagesRead(userId: string, peerId: string, ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return { ids: [] as string[], readAt: new Date().toISOString() };
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const existing = sqlite
      .prepare(`SELECT id FROM messages WHERE id IN (${placeholders}) AND "from" = ? AND "to" = ?`)
      .all(...uniqueIds, peerId, userId) as { id: string }[];
    const allowedIds = existing.map((row) => row.id);
    const readAt = new Date().toISOString();
    if (allowedIds.length) {
      const allowedPlaceholders = allowedIds.map(() => "?").join(", ");
      sqlite
        .prepare(`UPDATE messages SET deliveredAt = COALESCE(deliveredAt, ?), readAt = COALESCE(readAt, ?) WHERE id IN (${allowedPlaceholders})`)
        .run(readAt, readAt, ...allowedIds);
    }
    return { ids: allowedIds, readAt };
  },
  getMessagesFor(userId: string, peerId: string, limit = 100, offset = 0): MessageRecord[] {
    return (stmts.paginatedMessages.all({ userId, peerId, limit, offset }) as unknown[])
      .map(fromRow)
      .filter((msg): msg is MessageRecord => Boolean(msg))
      .reverse();
  },
  getChatList(userId: string): ChatSummary[] {
    const rows = stmts.chatList.all({ uid: userId }) as { peerId: string; lastMessageAt: string; lastContentType: string }[];
    return rows.map((row) => {
      const peer = stmts.findUserById.get(row.peerId) as UserRecord | undefined;
      return {
        peerId: row.peerId,
        peerPhone: peer?.phone ?? "Unknown",
        ...(peer?.login ? { peerLogin: peer.login } : {}),
        ...(peer?.publicKey ? { peerPublicKey: peer.publicKey } : {}),
        lastMessageAt: row.lastMessageAt,
        lastContentType: row.lastContentType,
      };
    });
  },
  getMessagesForUser(userId: string): MessageRecord[] {
    return (sqlite.prepare(`SELECT * FROM messages WHERE "from" = ? OR "to" = ?`).all(userId, userId) as unknown[])
      .map(fromRow)
      .filter((msg): msg is MessageRecord => Boolean(msg));
  },
  deleteOwnMessageForEveryone(id: string, userId: string, peerId: string) {
    return deleteOwnMessageTx(id, userId, peerId);
  },
  hideConversationFor(userId: string, peerId: string) {
    return stmts.hideConversation.run({ userId, peerId, hiddenAt: new Date().toISOString() }).changes;
  },
  deleteConversationBoth(userId: string, peerId: string) {
    return deleteConversationBothTx(userId, peerId);
  },
  saveKeyBackup(backup: KeyBackupRecord) {
    stmts.upsertBackup.run(backup);
  },
  getKeyBackup(userId: string): KeyBackupRecord | undefined {
    return stmts.getBackup.get(userId) as KeyBackupRecord | undefined;
  },
  createAuthQrSession(session: AuthQrSessionRecord) {
    stmts.insertAuthQrSession.run({
      ...session,
      status: session.status ?? "pending",
    });
  },
  getAuthQrSession(id: string, secretHash: string, now = new Date().toISOString()): AuthQrSessionRecord | undefined {
    return refreshAuthQrSession(id, secretHash, now);
  },
  approveAuthQrSession(
    id: string,
    secretHash: string,
    userId: string,
    approvedAt = new Date().toISOString(),
  ): AuthQrSessionRecord | undefined {
    return approveAuthQrSessionTx(id, secretHash, userId, approvedAt);
  },
  claimAuthQrSession(
    id: string,
    secretHash: string,
    claimedAt = new Date().toISOString(),
  ): AuthQrClaimResult {
    return claimAuthQrSessionTx(id, secretHash, claimedAt);
  },
  saveFile(file: StoredFileRecord) {
    stmts.insertFile.run({
      ...file,
      mimeType: file.mimeType ?? null,
    });
  },
  findFileForUser(fileId: string, userId: string): StoredFileRecord | undefined {
    return stmts.findFileForUser.get(fileId, userId, userId) as StoredFileRecord | undefined;
  },
  findFileById(fileId: string): StoredFileRecord | undefined {
    return stmts.findFileById.get(fileId) as StoredFileRecord | undefined;
  },
  saveDevice(device: DeviceRecord) {
    stmts.upsertDevice.run({
      ...device,
      label: device.label ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
    });
    stmts.upsertSyncState.run({
      deviceId: device.id,
      lastAckSeq: 0,
      updatedAt: device.updatedAt,
    });
  },
  touchDevice(userId: string, deviceId: string) {
    const lastSeenAt = new Date().toISOString();
    return stmts.touchDevice.run({ userId, deviceId, lastSeenAt }).changes > 0;
  },
  findDeviceById(deviceId: string): DeviceRecord | undefined {
    return stmts.findDeviceById.get(deviceId) as DeviceRecord | undefined;
  },
  findDeviceForUser(userId: string, deviceId: string): DeviceRecord | undefined {
    return stmts.findDeviceForUser.get(deviceId, userId) as DeviceRecord | undefined;
  },
  getActiveDevicesForUser(userId: string): DeviceRecord[] {
    return stmts.activeDevicesForUser.all(userId) as DeviceRecord[];
  },
  saveOneTimePreKeys(deviceId: string, keys: { keyId: number; publicKey: string }[]) {
    const tx = sqlite.transaction((items: { keyId: number; publicKey: string }[]) => {
      const createdAt = new Date().toISOString();
      for (const item of items) {
        stmts.upsertPreKey.run({ deviceId, keyId: item.keyId, publicKey: item.publicKey, createdAt });
      }
    });
    tx(keys);
  },
  claimPreKeyBundles(userIds: string[], excludeDeviceId?: string): PublicDeviceBundle[] {
    const bundles: PublicDeviceBundle[] = [];
    for (const userId of [...new Set(userIds)]) {
      const devices = (stmts.activeDevicesForUser.all(userId) as DeviceRecord[])
        .filter((device) => device.id !== excludeDeviceId);
      for (const device of devices) {
        bundles.push(claimPreKeyForDeviceTx(device));
      }
    }
    return bundles;
  },
  saveV2Message(input: SaveV2MessageInput): V2EnvelopeRecord[] {
    return saveV2MessageTx(input);
  },
  getV2SyncEnvelopes(userId: string, deviceId: string, afterSeq: number, limit = 100): V2EnvelopeRecord[] {
    if (!this.findDeviceForUser(userId, deviceId)) return [];
    return stmts.syncEnvelopesForDevice.all({
      deviceId,
      afterSeq,
      limit: Math.min(Math.max(limit, 1), 500),
    }) as V2EnvelopeRecord[];
  },
  ackV2Envelopes(userId: string, deviceId: string, envelopeIds: string[], readEnvelopeIds: string[] = []) {
    if (!this.findDeviceForUser(userId, deviceId)) {
      return { deliveredIds: [] as string[], readIds: [] as string[], at: new Date().toISOString(), lastAckSeq: 0 };
    }
    return ackV2EnvelopesTx(userId, deviceId, envelopeIds, readEnvelopeIds);
  },
  requestV2Retry(userId: string, deviceId: string, envelopeId: string) {
    const retryRequestedAt = new Date().toISOString();
    const result = stmts.requestEnvelopeRetry.run({ id: envelopeId, userId, deviceId, retryRequestedAt });
    if (result.changes === 0) return null;
    return {
      envelopeId,
      userId,
      deviceId,
      retryRequestedAt,
    };
  },
  getV2EnvelopesByIds(ids: string[]): V2EnvelopeRecord[] {
    return [...new Set(ids)]
      .map((id) => stmts.envelopesByIds.get(id) as V2EnvelopeRecord | undefined)
      .filter((row): row is V2EnvelopeRecord => Boolean(row));
  },
  migrateMessages(oldUserId: string, newUserId: string) {
    const c1 = stmts.migrateFrom.run(newUserId, oldUserId).changes;
    const c2 = stmts.migrateTo.run(newUserId, oldUserId).changes;
    return c1 + c2;
  },
  findOrphanedUserIds(): string[] {
    return (stmts.orphanedUserIds.all() as { u: string }[]).map((r) => r.u);
  },
};

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(path.join(dataDir, "mas.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

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
  CREATE INDEX IF NOT EXISTS idx_messages_from ON messages("from");
  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to");
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages("from", "to", createdAt);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(createdAt);
  CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  CREATE INDEX IF NOT EXISTS idx_users_login ON users(login);
`);

export type UserRecord = {
  id: string;
  phone: string;
  login?: string;
  publicKey?: string;
  secretKey?: string;
  status?: string;
  createdAt: string;
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

const stmts = {
  upsertUser: sqlite.prepare(`
    INSERT INTO users (id, phone, login, publicKey, secretKey, status, createdAt)
    VALUES (@id, @phone, @login, @publicKey, @secretKey, @status, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      phone=@phone, login=@login, publicKey=@publicKey, secretKey=@secretKey, status=@status
  `),
  findUserById: sqlite.prepare(`SELECT * FROM users WHERE id = ?`),
  findUserByPhone: sqlite.prepare(`SELECT * FROM users WHERE phone = ?`),
  findUserByLogin: sqlite.prepare(`SELECT * FROM users WHERE login = ?`),
  searchByLoginPrefix: sqlite.prepare(`SELECT * FROM users WHERE login LIKE ? AND id != ?`),
  isLoginTaken: sqlite.prepare(`SELECT 1 FROM users WHERE login = ? AND id != ?`),
  insertMessage: sqlite.prepare(`
    INSERT INTO messages (id, "from", "to", createdAt, contentType, body, meta, nonce, ciphertext,
      selfNonce, selfCiphertext, senderPublicKey, deliveredAt, readAt, editedAt, replyToId, pinned, reactions)
    VALUES (@id, @from, @to, @createdAt, @contentType, @body, @meta, @nonce, @ciphertext,
      @selfNonce, @selfCiphertext, @senderPublicKey, @deliveredAt, @readAt, @editedAt, @replyToId, @pinned, @reactions)
  `),
  getMessagesFor: sqlite.prepare(`
    SELECT * FROM messages WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?) ORDER BY createdAt ASC
  `),
  getMessagesForUser: sqlite.prepare(`
    SELECT * FROM messages WHERE "from" = ? OR "to" = ?
  `),
  deleteMessage: sqlite.prepare(`DELETE FROM messages WHERE id = ? AND ("from" = ? OR "to" = ?)`),
  deleteConversation: sqlite.prepare(`
    DELETE FROM messages WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)
  `),
  updateMessagePatch: sqlite.prepare(`
    UPDATE messages SET deliveredAt = COALESCE(@deliveredAt, deliveredAt),
      readAt = COALESCE(@readAt, readAt) WHERE id = ?
  `),
  editMessage: sqlite.prepare(`
    UPDATE messages SET ciphertext=@ciphertext, nonce=@nonce, selfCiphertext=@selfCiphertext,
      selfNonce=@selfNonce, senderPublicKey=@senderPublicKey, editedAt=@editedAt
    WHERE id = @id AND "from" = @userId
  `),
  togglePin: sqlite.prepare(`UPDATE messages SET pinned = NOT pinned WHERE id = ? AND ("from" = ? OR "to" = ?)`),
  getMessage: sqlite.prepare(`SELECT * FROM messages WHERE id = ?`),
  migrateFrom: sqlite.prepare(`UPDATE messages SET "from" = ? WHERE "from" = ?`),
  migrateTo: sqlite.prepare(`UPDATE messages SET "to" = ? WHERE "to" = ?`),
  orphanedUserIds: sqlite.prepare(`
    SELECT DISTINCT u FROM (
      SELECT "from" AS u FROM messages UNION SELECT "to" AS u FROM messages
    ) WHERE u NOT IN (SELECT id FROM users)
  `),
};

const toRow = (msg: any) => ({
  ...msg,
  meta: msg.meta ? JSON.stringify(msg.meta) : null,
  reactions: msg.reactions ? JSON.stringify(msg.reactions) : null,
  pinned: msg.pinned ? 1 : 0,
});

const fromRow = (row: any): any => {
  if (!row) return row;
  return {
    ...row,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions) : undefined,
    pinned: row.pinned === 1,
  };
};

export const db = {
  getUsers(): UserRecord[] {
    return sqlite.prepare(`SELECT * FROM users`).all() as UserRecord[];
  },
  saveUser(user: UserRecord) {
    stmts.upsertUser.run({
      id: user.id, phone: user.phone, login: user.login ?? null,
      publicKey: user.publicKey ?? null, secretKey: user.secretKey ?? null,
      status: user.status ?? null, createdAt: user.createdAt,
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
  editMessage(id: string, userId: string, patch: Partial<MessageRecord>) {
    stmts.editMessage.run({
      id, userId,
      ciphertext: patch.ciphertext ?? null, nonce: patch.nonce ?? null,
      selfCiphertext: patch.selfCiphertext ?? null, selfNonce: patch.selfNonce ?? null,
      senderPublicKey: patch.senderPublicKey ?? null,
      editedAt: new Date().toISOString(),
    });
    return fromRow(stmts.getMessage.get(id));
  },
  togglePin(id: string, userId: string) {
    stmts.togglePin.run(id, userId, userId);
    return fromRow(stmts.getMessage.get(id));
  },
  addReaction(id: string, userId: string, emoji: string) {
    const row = fromRow(stmts.getMessage.get(id));
    if (!row) return null;
    const reactions: Record<string, string[]> = row.reactions ?? {};
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(userId);
    if (idx >= 0) {
      reactions[emoji].splice(idx, 1);
      if (!reactions[emoji].length) delete reactions[emoji];
    } else {
      reactions[emoji] = [userId];
    }
    sqlite.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`).run(JSON.stringify(reactions), id);
    return { ...row, reactions };
  },
  updateMessages(ids: string[], patch: Partial<MessageRecord>) {
    const upd = sqlite.prepare(
      `UPDATE messages SET deliveredAt = COALESCE(?, deliveredAt), readAt = COALESCE(?, readAt) WHERE id = ?`
    );
    const txn = sqlite.transaction(() => {
      for (const id of ids) upd.run(patch.deliveredAt ?? null, patch.readAt ?? null, id);
    });
    txn();
  },
  getMessagesFor(userId: string, peerId: string, limit = 100, offset = 0): MessageRecord[] {
    return (sqlite.prepare(
      `SELECT * FROM messages WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)
       ORDER BY createdAt DESC LIMIT ? OFFSET ?`
    ).all(userId, peerId, peerId, userId, limit, offset) as any[]).map(fromRow).reverse();
  },
  getMessagesForUser(userId: string): MessageRecord[] {
    return (stmts.getMessagesForUser.all(userId, userId) as any[]).map(fromRow);
  },
  deleteMessage(id: string, userId: string) {
    return stmts.deleteMessage.run(id, userId, userId).changes > 0;
  },
  deleteConversation(userId: string, peerId: string) {
    return stmts.deleteConversation.run(userId, peerId, peerId, userId).changes;
  },
  migrateMessages(oldUserId: string, newUserId: string) {
    const c1 = stmts.migrateFrom.run(newUserId, oldUserId).changes;
    const c2 = stmts.migrateTo.run(newUserId, oldUserId).changes;
    return c1 + c2;
  },
  findOrphanedUserIds(): string[] {
    return (stmts.orphanedUserIds.all() as { u: string }[]).map((r) => r.u);
  },
  cleanOrphanedMessages() { return 0; },
  getPinnedMessages(userId: string, peerId: string) {
    return (sqlite.prepare(
      `SELECT * FROM messages WHERE pinned = 1 AND (("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?))`
    ).all(userId, peerId, peerId, userId) as any[]).map(fromRow);
  },
  searchMessages(userId: string, peerId: string, query: string) {
    return (sqlite.prepare(
      `SELECT * FROM messages WHERE (("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)) AND (body LIKE ? OR meta LIKE ?)`
    ).all(userId, peerId, peerId, userId, `%${query}%`, `%${query}%`) as any[]).map(fromRow);
  },
};

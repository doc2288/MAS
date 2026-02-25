import fs from "node:fs";
import path from "node:path";

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

type DbShape = {
  users: UserRecord[];
  messages: MessageRecord[];
};

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "db.json");

const ensureDb = () => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    const initial: DbShape = { users: [], messages: [] };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2), "utf-8");
  }
};

const readDb = (): DbShape => {
  ensureDb();
  const raw = fs.readFileSync(dbPath, "utf-8");
  return JSON.parse(raw) as DbShape;
};

const writeDb = (data: DbShape) => {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf-8");
};

export const db = {
  getUsers() {
    return readDb().users;
  },
  saveUser(user: UserRecord) {
    const data = readDb();
    const existingIndex = data.users.findIndex((item) => item.id === user.id);
    if (existingIndex >= 0) {
      data.users[existingIndex] = user;
    } else {
      data.users.push(user);
    }
    writeDb(data);
  },
  findUserByPhone(phone: string) {
    return readDb().users.find((item) => item.phone === phone);
  },
  findUserById(id: string) {
    return readDb().users.find((item) => item.id === id);
  },
  findUserByLogin(login: string) {
    return readDb().users.find((item) => item.login === login);
  },
  searchUsersByLoginPrefix(prefix: string, excludeUserId?: string) {
    const normalized = prefix.toLowerCase();
    return readDb().users.filter(
      (item) =>
        item.login &&
        item.login.startsWith(normalized) &&
        item.id !== excludeUserId
    );
  },
  isLoginTaken(login: string, excludeUserId?: string) {
    return readDb().users.some(
      (item) => item.login === login && item.id !== excludeUserId
    );
  },
  saveMessage(message: MessageRecord) {
    const data = readDb();
    data.messages.push(message);
    writeDb(data);
  },
  editMessage(id: string, userId: string, patch: Partial<MessageRecord>) {
    const data = readDb();
    const msg = data.messages.find((m) => m.id === id && m.from === userId);
    if (!msg) return null;
    Object.assign(msg, patch, { editedAt: new Date().toISOString() });
    writeDb(data);
    return msg;
  },
  togglePin(id: string, userId: string) {
    const data = readDb();
    const msg = data.messages.find(
      (m) => m.id === id && (m.from === userId || m.to === userId)
    );
    if (!msg) return null;
    msg.pinned = !msg.pinned;
    writeDb(data);
    return msg;
  },
  addReaction(id: string, userId: string, emoji: string) {
    const data = readDb();
    const msg = data.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(userId);
    if (idx >= 0) {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji] = [userId];
    }
    writeDb(data);
    return msg;
  },
  getPinnedMessages(userId: string, peerId: string) {
    return readDb().messages.filter(
      (msg) =>
        msg.pinned &&
        ((msg.from === userId && msg.to === peerId) ||
          (msg.from === peerId && msg.to === userId))
    );
  },
  searchMessages(userId: string, peerId: string, query: string) {
    const q = query.toLowerCase();
    return readDb().messages.filter(
      (msg) =>
        ((msg.from === userId && msg.to === peerId) ||
          (msg.from === peerId && msg.to === userId)) &&
        (msg.body?.toLowerCase().includes(q) ||
          msg.meta?.fileName?.toLowerCase().includes(q))
    );
  },
  updateMessages(ids: string[], patch: Partial<MessageRecord>) {
    const data = readDb();
    let changed = false;
    data.messages = data.messages.map((msg) => {
      if (ids.includes(msg.id)) {
        changed = true;
        return { ...msg, ...patch };
      }
      return msg;
    });
    if (changed) {
      writeDb(data);
    }
  },
  getMessagesFor(userId: string, peerId: string) {
    return readDb().messages.filter(
      (msg) =>
        (msg.from === userId && msg.to === peerId) ||
        (msg.from === peerId && msg.to === userId)
    );
  },
  getMessagesForUser(userId: string) {
    return readDb().messages.filter(
      (msg) => msg.from === userId || msg.to === userId
    );
  },
  deleteMessage(id: string, userId: string) {
    const data = readDb();
    const idx = data.messages.findIndex(
      (msg) => msg.id === id && (msg.from === userId || msg.to === userId)
    );
    if (idx >= 0) {
      data.messages.splice(idx, 1);
      writeDb(data);
      return true;
    }
    return false;
  },
  deleteConversation(userId: string, peerId: string) {
    const data = readDb();
    const before = data.messages.length;
    data.messages = data.messages.filter(
      (msg) =>
        !((msg.from === userId && msg.to === peerId) ||
          (msg.from === peerId && msg.to === userId))
    );
    if (data.messages.length !== before) {
      writeDb(data);
      return before - data.messages.length;
    }
    return 0;
  },
  migrateMessages(oldUserId: string, newUserId: string) {
    const data = readDb();
    let migrated = 0;
    data.messages = data.messages.map((msg) => {
      let changed = false;
      const patched = { ...msg };
      if (msg.from === oldUserId) { patched.from = newUserId; changed = true; }
      if (msg.to === oldUserId) { patched.to = newUserId; changed = true; }
      if (changed) migrated++;
      return patched;
    });
    if (migrated > 0) writeDb(data);
    return migrated;
  },
  findOrphanedUserIds() {
    const data = readDb();
    const userIds = new Set(data.users.map((u) => u.id));
    const orphaned = new Set<string>();
    for (const msg of data.messages) {
      if (!userIds.has(msg.from)) orphaned.add(msg.from);
      if (!userIds.has(msg.to)) orphaned.add(msg.to);
    }
    return Array.from(orphaned);
  },
  cleanOrphanedMessages() {
    const data = readDb();
    const userIds = new Set(data.users.map((u) => u.id));
    const before = data.messages.length;
    data.messages = data.messages.filter(
      (msg) => userIds.has(msg.from) && userIds.has(msg.to)
    );
    if (data.messages.length !== before) {
      writeDb(data);
    }
    return before - data.messages.length;
  }
};

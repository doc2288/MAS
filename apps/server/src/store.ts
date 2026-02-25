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
  contentType: "text" | "file" | "emoji" | "sticker" | "gif" | "call";
  body?: string;
  meta?: Record<string, string>;
  nonce?: string;
  ciphertext?: string;
  selfNonce?: string;
  selfCiphertext?: string;
  deliveredAt?: string;
  readAt?: string;
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

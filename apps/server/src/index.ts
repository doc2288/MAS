import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import multer from "multer";
import { attachWebSocket } from "./ws.js";
import { db } from "./store.js";
import { requestSmsCode, verifySmsCode, verifyToken } from "./auth.js";

const app = express();
const server = http.createServer(app);
attachWebSocket(server);

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadDir));

const normalizeLogin = (login: string) => login.trim().toLowerCase();
const isValidLogin = (login: string) => /^[a-z0-9._]{3,20}$/.test(login);

app.post("/auth/request", (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) {
    res.status(400).json({ error: "phone_required" });
    return;
  }
  const { code } = requestSmsCode(phone);
  res.json({ ok: true, devCode: code });
});

app.post("/auth/verify", (req, res) => {
  const { phone, code } = req.body as { phone?: string; code?: string };
  if (!phone || !code) {
    res.status(400).json({ error: "phone_or_code_required" });
    return;
  }
  const result = verifySmsCode(phone, code);
  if (!result) {
    res.status(401).json({ error: "invalid_code" });
    return;
  }
  res.json(result);
});

app.get("/users/me", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const user = db.findUserById(userId);
  res.json(user);
});

app.get("/users/by-phone", (req, res) => {
  const phone = req.query.phone as string | undefined;
  if (!phone) {
    res.status(400).json({ error: "phone_required" });
    return;
  }
  const user = db.findUserByPhone(phone);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(user);
});

app.get("/users/by-login", (req, res) => {
  const login = req.query.login as string | undefined;
  if (!login) {
    res.status(400).json({ error: "login_required" });
    return;
  }
  const normalized = normalizeLogin(login);
  const user = db.findUserByLogin(normalized);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(user);
});

app.get("/users/search", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const query = req.query.query as string | undefined;
  if (!query) {
    res.status(400).json({ error: "query_required" });
    return;
  }
  const normalized = normalizeLogin(query);
  if (!isValidLogin(normalized)) {
    res.json([]);
    return;
  }
  const users = db.searchUsersByLoginPrefix(normalized, userId);
  res.json(
    users.map((u) => ({
      id: u.id,
      phone: u.phone,
      login: u.login,
      publicKey: u.publicKey
    }))
  );
});

app.post("/users/login", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { login } = req.body as { login?: string };
  if (!login) {
    res.status(400).json({ error: "login_required" });
    return;
  }
  const normalized = normalizeLogin(login);
  if (!isValidLogin(normalized)) {
    res.status(400).json({ error: "login_invalid" });
    return;
  }
  if (db.isLoginTaken(normalized, userId)) {
    res.status(409).json({ error: "login_taken" });
    return;
  }
  const user = db.findUserById(userId);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  user.login = normalized;
  db.saveUser(user);
  res.json({ ok: true, login: normalized });
});

app.get("/users/:id", (req, res) => {
  const user = db.findUserById(req.params.id);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(user);
});

app.post("/keys", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { publicKey, secretKey } = req.body as { publicKey?: string; secretKey?: string };
  if (!publicKey) {
    res.status(400).json({ error: "public_key_required" });
    return;
  }
  const user = db.findUserById(userId);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  user.publicKey = publicKey;
  if (secretKey) {
    user.secretKey = secretKey;
  }
  db.saveUser(user);
  res.json({ ok: true });
});

app.get("/keys/pair", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const user = db.findUserById(userId);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (user.publicKey && user.secretKey) {
    res.json({ publicKey: user.publicKey, secretKey: user.secretKey });
  } else {
    res.json({ publicKey: user.publicKey ?? null, secretKey: null });
  }
});

app.get("/messages/:peerId", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const peerId = req.params.peerId;
  const messages = db.getMessagesFor(userId, peerId);
  res.json(messages);
});

app.get("/chats", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const all = db.getMessagesForUser(userId);
  const map = new Map<string, typeof all[0]>();
  for (const message of all) {
    const peerId = message.from === userId ? message.to : message.from;
    const existing = map.get(peerId);
    if (!existing || existing.createdAt < message.createdAt) {
      map.set(peerId, message);
    }
  }
  const chats = Array.from(map.entries())
    .map(([peerId, lastMessage]) => {
      const peer = db.findUserById(peerId);
      return {
        peerId,
        peerPhone: peer?.phone ?? "Unknown",
        peerLogin: peer?.login,
        peerPublicKey: peer?.publicKey,
        lastMessageAt: lastMessage.createdAt,
        lastContentType: lastMessage.contentType
      };
    })
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  res.json(chats);
});

app.post("/files", upload.single("file"), (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "file_required" });
    return;
  }
  const fileId = crypto.randomUUID();
  const url = `/uploads/${req.file.filename}`;
  res.json({ fileId, url });
});

app.delete("/messages/:peerId", (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const userId = token ? verifyToken(token) : null;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const count = db.deleteConversation(userId, req.params.peerId);
  res.json({ ok: true, deleted: count });
});

const port = Number(process.env.PORT || 4000);
server.listen(port, () => {
  console.log(`MAS server listening on http://localhost:${port}`);
});

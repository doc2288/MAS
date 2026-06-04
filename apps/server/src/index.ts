import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { attachWebSocket, sendToDevice, sendToUser, sendToUserDevices } from "./ws.js";
import { db, toPublicUser } from "./store.js";
import { issueAuthToken, requestSmsCode, verifySmsCode, verifyToken } from "./auth.js";
import { CHAT_MODE } from "./config.js";

type AuthenticatedRequest = express.Request & { userId: string };
type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const app = express();
const server = http.createServer(app);
attachWebSocket(server);

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 4 }
});

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
  "tauri://localhost",
  "http://tauri.localhost"
];
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS?.split(",") ?? defaultOrigins)
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin)) {
      cb(null, true);
      return;
    }
    cb(new Error("cors_origin_not_allowed"));
  }
}));
app.use(express.json({ limit: "2mb" }));

const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" }
});
const qrAuthLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" }
});
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" }
});

app.use("/auth/request", authLimiter);
app.use("/auth/verify", authLimiter);
app.use("/auth/qr", qrAuthLimiter);
app.use("/users", apiLimiter);
app.use("/messages", apiLimiter);
app.use("/keys", apiLimiter);
app.use("/chats", apiLimiter);
app.use("/files", apiLimiter);
app.use("/devices", apiLimiter);
app.use("/prekey-bundles", apiLimiter);
app.use("/sync", apiLimiter);
app.use("/config", apiLimiter);

const normalizeLogin = (login: string) => login.trim().toLowerCase();
const isValidLogin = (login: string) => /^[a-z0-9._]{3,20}$/.test(login);
const isValidId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;
const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const optionalBoundedString = (value: unknown, max: number): string | undefined =>
  isBoundedString(value, max) ? value : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const v2ContentTypes = new Set(["text", "file", "emoji", "sticker", "gif", "call", "voice"]);
const defaultIceServers: IceServerConfig[] = [{ urls: "stun:stun.l.google.com:19302" }];

const isIceUrl = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  /^(stun|stuns|turn|turns):/i.test(value);

const sanitizeIceServer = (value: unknown): IceServerConfig | null => {
  if (!isRecord(value)) return null;
  const cleanUrls = typeof value.urls === "string"
    ? (isIceUrl(value.urls) ? value.urls : null)
    : Array.isArray(value.urls)
      ? value.urls.filter(isIceUrl).slice(0, 8)
      : null;
  if (!cleanUrls || (Array.isArray(cleanUrls) && cleanUrls.length === 0)) return null;

  const username = optionalBoundedString(value.username, 512);
  const credential = optionalBoundedString(value.credential, 512);
  return {
    urls: cleanUrls,
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {})
  };
};

const loadIceServers = (): IceServerConfig[] => {
  const raw = process.env.ICE_SERVERS_JSON;
  if (!raw) return defaultIceServers;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 20) throw new Error("ICE_SERVERS_JSON must be an array");
    const sanitized = parsed.map(sanitizeIceServer).filter(Boolean) as IceServerConfig[];
    return sanitized.length ? sanitized : defaultIceServers;
  } catch (err) {
    console.warn(`[config] Invalid ICE_SERVERS_JSON; using default STUN. ${(err as Error).message}`);
    return defaultIceServers;
  }
};

const iceServers = loadIceServers();

const requireAuth = (req: express.Request): string | null => {
  const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ? verifyToken(match[1]) : null;
};

const requireAuthMiddleware: express.RequestHandler = (req, res, next) => {
  const userId = requireAuth(req);
  if (!userId || !db.findUserById(userId)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  (req as AuthenticatedRequest).userId = userId;
  next();
};

const removeUploadedFile = (file?: Express.Multer.File) => {
  if (!file) return;
  fs.promises.unlink(file.path).catch(() => {});
};

const parsePageLimit = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
};

const parsePageOffset = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const QR_LOGIN_TTL_MS = 2 * 60 * 1000;

const randomToken = (bytes = 32) =>
  crypto.randomBytes(bytes).toString("base64url");

const hashQrSecret = (secret: string) =>
  crypto.createHash("sha256").update(secret).digest("hex");

const buildQrPayload = (qrSessionId: string, secret: string) =>
  `mas-auth://qr?session=${encodeURIComponent(qrSessionId)}&secret=${encodeURIComponent(secret)}`;

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get("/config/ice", requireAuthMiddleware, (_req, res) => {
  res.json({ iceServers });
});

app.get("/config/client", (_req, res) => {
  res.json({ chatMode: CHAT_MODE });
});

app.post("/auth/request", (req, res) => {
  const { phone } = req.body as { phone?: unknown };
  if (!isBoundedString(phone, 20) || phone.length < 5) {
    res.status(400).json({ error: "phone_required" });
    return;
  }
  const result = requestSmsCode(phone);
  if (!result.ok) {
    res.status(503).json({ error: result.error });
    return;
  }
  res.json({ ok: true, ...("code" in result ? { devCode: result.code } : {}) });
});

app.post("/auth/verify", (req, res) => {
  const { phone, code } = req.body as { phone?: unknown; code?: unknown };
  if (!isBoundedString(phone, 20) || !isBoundedString(code, 12)) {
    res.status(400).json({ error: "phone_or_code_required" });
    return;
  }
  const result = verifySmsCode(phone, code);
  if (!result) {
    res.status(401).json({ error: "invalid_code" });
    return;
  }
  res.json({ token: result.token, user: toPublicUser(result.user, true) });
});

app.post("/auth/qr/start", (_req, res) => {
  const qrSessionId = crypto.randomUUID();
  const secret = randomToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + QR_LOGIN_TTL_MS).toISOString();
  db.createAuthQrSession({
    id: qrSessionId,
    secretHash: hashQrSecret(secret),
    status: "pending",
    createdAt: createdAt.toISOString(),
    expiresAt,
  });
  res.json({
    qrSessionId,
    qrPayload: buildQrPayload(qrSessionId, secret),
    expiresAt,
  });
});

app.get("/auth/qr/status/:id", (req, res) => {
  const { id } = req.params;
  const secret = req.query.secret;
  if (!isValidId(id) || !isBoundedString(secret, 256)) {
    res.status(400).json({ error: "qr_invalid" });
    return;
  }
  const result = db.claimAuthQrSession(id, hashQrSecret(secret));
  if (!result) {
    res.status(404).json({ error: "qr_not_found" });
    return;
  }
  if (result.status !== "claimed" || !result.userId) {
    res.json({ status: result.status });
    return;
  }
  const user = db.findUserById(result.userId);
  if (!user) {
    res.status(409).json({ error: "qr_user_missing" });
    return;
  }
  res.json({
    status: "claimed",
    token: issueAuthToken(user),
    user: toPublicUser(user, true),
  });
});

app.post("/auth/qr/approve", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { qrSessionId, secret } = req.body as { qrSessionId?: unknown; secret?: unknown };
  if (!isValidId(qrSessionId) || !isBoundedString(secret, 256)) {
    res.status(400).json({ error: "qr_invalid" });
    return;
  }
  const session = db.approveAuthQrSession(qrSessionId, hashQrSecret(secret), userId);
  if (!session) {
    res.status(404).json({ error: "qr_not_found" });
    return;
  }
  if (session.status !== "approved") {
    res.status(409).json({ error: `qr_${session.status}`, status: session.status });
    return;
  }
  res.json({ ok: true, status: session.status, approvedAt: session.approvedAt });
});

app.get("/users/me", requireAuthMiddleware, (req, res) => {
  const user = db.findUserById((req as AuthenticatedRequest).userId);
  if (!user) {
    res.status(401).json({ error: "user_not_found" });
    return;
  }
  res.json(toPublicUser(user, true));
});

app.get("/users/by-phone", requireAuthMiddleware, (req, res) => {
  const phone = req.query.phone;
  if (!isBoundedString(phone, 32)) {
    res.status(400).json({ error: "phone_required" });
    return;
  }
  const user = db.findUserByPhone(phone);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(toPublicUser(user));
});

app.get("/users/by-login", requireAuthMiddleware, (req, res) => {
  const login = req.query.login;
  if (!isBoundedString(login, 32)) {
    res.status(400).json({ error: "login_required" });
    return;
  }
  const normalized = normalizeLogin(login);
  if (!isValidLogin(normalized)) {
    res.status(400).json({ error: "login_invalid" });
    return;
  }
  const user = db.findUserByLogin(normalized);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(toPublicUser(user));
});

app.get("/users/search", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const query = req.query.query;
  if (!isBoundedString(query, 32)) {
    res.status(400).json({ error: "query_required" });
    return;
  }
  const normalized = normalizeLogin(query);
  if (!isValidLogin(normalized)) {
    res.json([]);
    return;
  }
  const users = db.searchUsersByLoginPrefix(normalized, userId);
  res.json(users.map((u) => toPublicUser(u)));
});

app.post("/users/login", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { login } = req.body as { login?: unknown };
  if (!isBoundedString(login, 32)) {
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

app.get("/users/:id", requireAuthMiddleware, (req, res) => {
  if (!isValidId(req.params.id)) {
    res.status(400).json({ error: "id_invalid" });
    return;
  }
  const user = db.findUserById(req.params.id);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(toPublicUser(user));
});

app.post("/devices/register", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const body = req.body as Record<string, unknown>;
  const signedPreKey = isRecord(body.signedPreKey) ? body.signedPreKey : null;
  const deviceId = optionalBoundedString(body.deviceId, 128) ?? crypto.randomUUID();
  const label = optionalBoundedString(body.label, 128);
  const identityKey = optionalBoundedString(body.identityKey, 2048);
  const registrationId = body.registrationId;
  const signedPreKeyId = signedPreKey?.keyId;
  const signedPreKeyPublic = optionalBoundedString(signedPreKey?.publicKey, 2048);
  const signedPreKeySignature = optionalBoundedString(signedPreKey?.signature, 2048);
  if (
    !isValidId(deviceId) ||
    !identityKey ||
    typeof registrationId !== "number" ||
    !Number.isInteger(registrationId) ||
    registrationId <= 0 ||
    registrationId > 0x7fffffff ||
    typeof signedPreKeyId !== "number" ||
    !Number.isInteger(signedPreKeyId) ||
    signedPreKeyId < 0 ||
    !signedPreKeyPublic ||
    !signedPreKeySignature
  ) {
    res.status(400).json({ error: "device_invalid" });
    return;
  }

  const now = new Date().toISOString();
  db.saveDevice({
    id: deviceId,
    userId,
    label,
    identityKey,
    registrationId,
    signedPreKeyId,
    signedPreKeyPublic,
    signedPreKeySignature,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  res.json({ ok: true, deviceId });
});

app.post("/devices/:deviceId/prekeys", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { deviceId } = req.params;
  if (!isValidId(deviceId) || !db.findDeviceForUser(userId, deviceId)) {
    res.status(404).json({ error: "device_not_found" });
    return;
  }
  const rawKeys = (req.body as { oneTimePreKeys?: unknown; preKeys?: unknown }).oneTimePreKeys
    ?? (req.body as { preKeys?: unknown }).preKeys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.length > 500) {
    res.status(400).json({ error: "prekeys_invalid" });
    return;
  }
  const keys = rawKeys.map((item) => {
    if (!isRecord(item)) return null;
    const keyId = item.keyId;
    const publicKey = optionalBoundedString(item.publicKey, 2048);
    return typeof keyId === "number" && Number.isInteger(keyId) && keyId >= 0 && publicKey
      ? { keyId, publicKey }
      : null;
  });
  if (keys.some((item) => !item)) {
    res.status(400).json({ error: "prekeys_invalid" });
    return;
  }
  db.saveOneTimePreKeys(deviceId, keys as { keyId: number; publicKey: string }[]);
  res.json({ ok: true, count: keys.length });
});

app.post("/prekey-bundles/claim", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const body = req.body as { userIds?: unknown; recipientUserIds?: unknown; excludeDeviceId?: unknown };
  const rawUserIds = Array.isArray(body.userIds) ? body.userIds : body.recipientUserIds;
  if (!Array.isArray(rawUserIds) || rawUserIds.length === 0 || rawUserIds.length > 50) {
    res.status(400).json({ error: "recipients_invalid" });
    return;
  }
  const userIds = rawUserIds.filter(isValidId);
  if (userIds.length !== rawUserIds.length) {
    res.status(400).json({ error: "recipients_invalid" });
    return;
  }
  for (const id of userIds) {
    if (!db.findUserById(id)) {
      res.status(404).json({ error: "recipient_not_found", userId: id });
      return;
    }
  }
  const excludeDeviceId = optionalBoundedString(body.excludeDeviceId, 128);
  const bundles = db.claimPreKeyBundles([...new Set(userIds)], excludeDeviceId);
  res.json({ bundles, requestedBy: userId });
});

app.post("/keys", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { publicKey } = req.body as { publicKey?: unknown };
  if (!isBoundedString(publicKey, 512)) {
    res.status(400).json({ error: "public_key_required" });
    return;
  }
  const user = db.findUserById(userId);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  user.publicKey = publicKey;
  user.secretKey = null;
  db.saveUser(user);
  res.json({ ok: true });
});

app.get("/keys/pair", requireAuthMiddleware, (req, res) => {
  const user = db.findUserById((req as AuthenticatedRequest).userId);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ publicKey: user.publicKey ?? null, secretKey: null });
});

app.get("/keys/backup", requireAuthMiddleware, (req, res) => {
  const backup = db.getKeyBackup((req as AuthenticatedRequest).userId);
  if (!backup) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    publicKey: backup.publicKey,
    backup: {
      ciphertext: backup.ciphertext,
      salt: backup.salt,
      nonce: backup.nonce,
      kdf: backup.kdf,
      iterations: backup.iterations,
      updatedAt: backup.updatedAt
    }
  });
});

app.put("/keys/backup", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { publicKey, backup } = req.body as {
    publicKey?: unknown;
    backup?: {
      ciphertext?: unknown;
      salt?: unknown;
      nonce?: unknown;
      kdf?: unknown;
      iterations?: unknown;
    };
  };
  if (
    !isBoundedString(publicKey, 512) ||
    !backup ||
    !isBoundedString(backup.ciphertext, 16384) ||
    !isBoundedString(backup.salt, 512) ||
    !isBoundedString(backup.nonce, 512) ||
    backup.kdf !== "PBKDF2-SHA256" ||
    typeof backup.iterations !== "number" ||
    !Number.isInteger(backup.iterations) ||
    backup.iterations < 100_000 ||
    backup.iterations > 1_000_000
  ) {
    res.status(400).json({ error: "backup_invalid" });
    return;
  }
  const user = db.findUserById(userId);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  user.publicKey = publicKey;
  user.secretKey = null;
  db.saveUser(user);
  db.saveKeyBackup({
    userId,
    publicKey,
    ciphertext: backup.ciphertext,
    salt: backup.salt,
    nonce: backup.nonce,
    kdf: "PBKDF2-SHA256",
    iterations: backup.iterations,
    updatedAt: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.post("/messages/v2", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const body = req.body as Record<string, unknown>;
  const clientMessageId = optionalBoundedString(body.clientMessageId, 128);
  const senderDeviceId = optionalBoundedString(body.senderDeviceId, 128);
  const contentType = optionalBoundedString(body.contentType, 32);
  const createdAt = optionalBoundedString(body.createdAt, 64) ?? new Date().toISOString();
  const rawRecipientUserIds = body.recipientUserIds;
  const rawEnvelopes = body.envelopes;

  if (
    !clientMessageId ||
    !senderDeviceId ||
    !contentType ||
    !v2ContentTypes.has(contentType) ||
    !Array.isArray(rawRecipientUserIds) ||
    rawRecipientUserIds.length === 0 ||
    rawRecipientUserIds.length > 50 ||
    !Array.isArray(rawEnvelopes) ||
    rawEnvelopes.length === 0 ||
    rawEnvelopes.length > 500 ||
    "text" in body ||
    "body" in body ||
    "plaintext" in body
  ) {
    res.status(400).json({ error: "message_v2_invalid" });
    return;
  }

  const senderDevice = db.findDeviceForUser(userId, senderDeviceId);
  if (!senderDevice || senderDevice.status !== "active") {
    res.status(403).json({ error: "sender_device_invalid" });
    return;
  }

  const recipientUserIds = rawRecipientUserIds.filter(isValidId);
  if (recipientUserIds.length !== rawRecipientUserIds.length) {
    res.status(400).json({ error: "recipients_invalid" });
    return;
  }
  for (const recipientUserId of recipientUserIds) {
    if (!db.findUserById(recipientUserId)) {
      res.status(404).json({ error: "recipient_not_found", userId: recipientUserId });
      return;
    }
  }

  const envelopes = rawEnvelopes.map((item) => {
    if (!isRecord(item)) return null;
    const id = optionalBoundedString(item.id, 128) ?? crypto.randomUUID();
    const recipientUserId = optionalBoundedString(item.recipientUserId, 128);
    const recipientDeviceId = optionalBoundedString(item.recipientDeviceId, 128);
    const rawEnvelopeType = optionalBoundedString(item.envelopeType, 32);
    const ciphertext = optionalBoundedString(item.ciphertext, 1_048_576);
    const sessionId = optionalBoundedString(item.sessionId, 256);
    const preKeyId = item.preKeyId;
    if (
      !isValidId(id) ||
      !recipientUserId ||
      !recipientDeviceId ||
      (rawEnvelopeType !== "prekey" && rawEnvelopeType !== "signal" && rawEnvelopeType !== "retry") ||
      !ciphertext
    ) return null;
    const envelopeType: "prekey" | "signal" | "retry" = rawEnvelopeType;
    const recipientDevice = db.findDeviceForUser(recipientUserId, recipientDeviceId);
    if (!recipientDevice || recipientDevice.status !== "active") return null;
    if (!recipientUserIds.includes(recipientUserId)) return null;
    return {
      id,
      recipientUserId,
      recipientDeviceId,
      envelopeType,
      ciphertext,
      ...(sessionId ? { sessionId } : {}),
      ...(typeof preKeyId === "number" && Number.isInteger(preKeyId) ? { preKeyId } : {}),
    };
  });
  if (envelopes.some((item) => !item)) {
    res.status(400).json({ error: "envelopes_invalid" });
    return;
  }

  const serverReceivedAt = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const uniqueConversationUsers = [...new Set([userId, ...recipientUserIds])].sort();
  const conversationId = optionalBoundedString(body.conversationId, 256) ?? uniqueConversationUsers.join(":");
  const saved = db.saveV2Message({
    message: {
      id: messageId,
      clientMessageId,
      senderUserId: userId,
      senderDeviceId,
      conversationId,
      contentType: contentType as any,
      createdAt: Number.isNaN(Date.parse(createdAt)) ? serverReceivedAt : createdAt,
      serverReceivedAt,
    },
    envelopes: envelopes as NonNullable<(typeof envelopes)[number]>[],
  });

  for (const envelope of saved) {
    sendToDevice(envelope.recipientDeviceId, {
      type: "envelope.available",
      payload: {
        envelopeId: envelope.id,
        messageId: envelope.messageId,
        deviceSeq: envelope.deviceSeq,
      },
    });
  }

  res.json({
    ok: true,
    messageId: saved[0]?.messageId ?? messageId,
    clientMessageId,
    acceptedAt: serverReceivedAt,
    envelopeIds: saved.map((item) => item.id),
  });
});

app.get("/sync/v2", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const deviceId = req.query.deviceId;
  if (!isValidId(deviceId) || !db.findDeviceForUser(userId, deviceId)) {
    res.status(404).json({ error: "device_not_found" });
    return;
  }
  const afterSeq = Math.max(0, Number.parseInt(String(req.query.afterSeq ?? "0"), 10) || 0);
  const limit = parsePageLimit(req.query.limit);
  const envelopes = db.getV2SyncEnvelopes(userId, deviceId, afterSeq, limit);
  db.touchDevice(userId, deviceId);
  res.json({
    deviceId,
    envelopes,
    nextSeq: envelopes.length ? envelopes[envelopes.length - 1].deviceSeq : afterSeq,
  });
});

app.post("/sync/v2/ack", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const body = req.body as { deviceId?: unknown; envelopeIds?: unknown; readEnvelopeIds?: unknown };
  const deviceId = body.deviceId;
  if (!isValidId(deviceId) || !db.findDeviceForUser(userId, deviceId)) {
    res.status(404).json({ error: "device_not_found" });
    return;
  }
  const envelopeIds = Array.isArray(body.envelopeIds) ? body.envelopeIds.filter(isValidId) : [];
  const readEnvelopeIds = Array.isArray(body.readEnvelopeIds) ? body.readEnvelopeIds.filter(isValidId) : [];
  if (!envelopeIds.length && !readEnvelopeIds.length) {
    res.status(400).json({ error: "ack_empty" });
    return;
  }
  const result = db.ackV2Envelopes(userId, deviceId, envelopeIds, readEnvelopeIds);
  const changed = db.getV2EnvelopesByIds([...result.deliveredIds, ...result.readIds]);
  for (const envelope of changed) {
    const eventType = result.readIds.includes(envelope.id) ? "message.read" : "message.delivered";
    sendToUserDevices(envelope.senderUserId, {
      type: eventType,
      payload: {
        messageId: envelope.messageId,
        envelopeId: envelope.id,
        recipientUserId: envelope.recipientUserId,
        recipientDeviceId: envelope.recipientDeviceId,
        at: result.at,
      },
    }, envelope.senderDeviceId);
  }
  res.json({ ok: true, ...result });
});

app.post("/sync/v2/retry-request", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const body = req.body as { deviceId?: unknown; envelopeId?: unknown; reason?: unknown };
  const deviceId = body.deviceId;
  const envelopeId = body.envelopeId;
  if (!isValidId(deviceId) || !isValidId(envelopeId) || !db.findDeviceForUser(userId, deviceId)) {
    res.status(400).json({ error: "retry_invalid" });
    return;
  }
  const retry = db.requestV2Retry(userId, deviceId, envelopeId);
  if (!retry) {
    res.status(409).json({ error: "retry_not_available" });
    return;
  }
  const [envelope] = db.getV2EnvelopesByIds([envelopeId]);
  if (envelope) {
    sendToUserDevices(envelope.senderUserId, {
      type: "retry.request",
      payload: {
        envelopeId,
        messageId: envelope.messageId,
        recipientUserId: userId,
        recipientDeviceId: deviceId,
        reason: optionalBoundedString(body.reason, 128) ?? "decrypt_failed",
        retryRequestedAt: retry.retryRequestedAt,
      },
    }, envelope.senderDeviceId);
  }
  res.json({ ok: true, ...retry });
});

app.get("/messages/:peerId", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  if (!isValidId(req.params.peerId)) {
    res.status(400).json({ error: "peer_invalid" });
    return;
  }
  const limit = parsePageLimit(req.query.limit);
  const offset = parsePageOffset(req.query.offset);
  res.json(db.getMessagesFor(userId, req.params.peerId, limit, offset));
});

app.get("/chats", requireAuthMiddleware, (req, res) => {
  res.json(db.getChatList((req as AuthenticatedRequest).userId));
});

app.post("/files", requireAuthMiddleware, upload.single("file"), (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { peerId } = req.body as { peerId?: unknown };
  if (!isValidId(peerId)) {
    removeUploadedFile(req.file);
    res.status(400).json({ error: "peer_required" });
    return;
  }
  if (!db.findUserById(peerId)) {
    removeUploadedFile(req.file);
    res.status(404).json({ error: "peer_not_found" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "file_required" });
    return;
  }
  const fileId = crypto.randomUUID();
  db.saveFile({
    id: fileId,
    ownerId: userId,
    peerId,
    filename: req.file.filename,
    originalName: req.file.originalname.slice(0, 255),
    mimeType: req.file.mimetype,
    size: req.file.size,
    createdAt: new Date().toISOString()
  });
  res.json({ fileId, url: `/files/${fileId}` });
});

app.get("/files/:fileId", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  if (!isValidId(req.params.fileId)) {
    res.status(400).json({ error: "file_invalid" });
    return;
  }
  const file = db.findFileForUser(req.params.fileId, userId);
  if (!file) {
    if (db.findFileById(req.params.fileId)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.status(404).json({ error: "not_found" });
    return;
  }
  const filePath = path.join(uploadDir, file.filename);
  res.sendFile(filePath, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store"
    }
  });
});

app.delete("/messages/:peerId", requireAuthMiddleware, (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const peerId = req.params.peerId;
  const scope = req.query.scope === "both" ? "both" : "me";
  if (!isValidId(peerId)) {
    res.status(400).json({ error: "peer_invalid" });
    return;
  }
  if (!db.findUserById(peerId)) {
    res.status(404).json({ error: "peer_not_found" });
    return;
  }
  if (scope === "both") {
    const count = db.deleteConversationBoth(userId, peerId);
    sendToUser(peerId, { type: "conversation.deleted", payload: { peerId: userId, scope: "both" } });
    res.json({ ok: true, scope, deleted: count });
    return;
  }
  const count = db.hideConversationFor(userId, peerId);
  res.json({ ok: true, scope, hidden: count });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.message === "cors_origin_not_allowed") {
    res.status(403).json({ error: "cors_origin_not_allowed" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`MAS server listening on http://${host}:${port}`);
});

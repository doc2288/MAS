import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { db, MessageRecord } from "./store.js";
import { CHAT_MODE } from "./config.js";

export type SocketClient = {
  userId: string;
  deviceId?: string;
  socket: WebSocket;
};

type ServerEvent = {
  type: string;
  payload?: unknown;
};

const clients = new Map<string, SocketClient>();
const deviceClients = new Map<string, SocketClient>();
const onlineUsers = new Map<string, string>();
const contactSubscriptions = new Map<string, Set<string>>();
const wsRateLimits = new Map<string, { count: number; resetAt: number }>();

const WS_RATE_LIMIT = 60;
const WS_RATE_WINDOW = 10_000;
const MAX_WS_JSON_BYTES = 512_000;
const contentTypes = new Set<MessageRecord["contentType"]>(["text", "file", "emoji", "sticker", "gif", "call", "voice"]);

export const sendToUser = (userId: string, event: ServerEvent) => {
  const data = JSON.stringify(event);
  const sent = new Set<WebSocket>();
  const legacy = clients.get(userId);
  if (legacy) {
    safeSend(legacy.socket, data);
    sent.add(legacy.socket);
  }
  for (const client of deviceClients.values()) {
    if (client.userId === userId && !sent.has(client.socket)) {
      safeSend(client.socket, data);
      sent.add(client.socket);
    }
  }
};

export const sendToDevice = (deviceId: string, event: ServerEvent) => {
  const client = deviceClients.get(deviceId);
  if (client) safeSend(client.socket, JSON.stringify(event));
};

export const sendToUserDevices = (userId: string, event: ServerEvent, excludeDeviceId?: string) => {
  const data = JSON.stringify(event);
  for (const client of deviceClients.values()) {
    if (client.userId === userId && client.deviceId !== excludeDeviceId) {
      safeSend(client.socket, data);
    }
  }
};

const checkWsRate = (userId: string): boolean => {
  const now = Date.now();
  const entry = wsRateLimits.get(userId);
  if (!entry || now > entry.resetAt) {
    wsRateLimits.set(userId, { count: 1, resetAt: now + WS_RATE_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= WS_RATE_LIMIT;
};

const safeSend = (socket: WebSocket, data: string) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
};

const hasUserConnection = (userId: string) =>
  Boolean(clients.get(userId)) || [...deviceClients.values()].some((client) => client.userId === userId);

const sendError = (socket: WebSocket, message: string) => {
  safeSend(socket, JSON.stringify({ type: "error", payload: { message } }));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const isSafeId = (value: unknown): value is string => isBoundedString(value, 128);

const optionalString = (value: unknown, max: number): string | undefined =>
  isBoundedString(value, max) ? value : undefined;

const optionalBodyString = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

const parseCreatedAt = (value: unknown) => {
  if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) {
    return new Date().toISOString();
  }
  return value;
};

const sanitizeMeta = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([key, entryValue]) =>
      key.length > 0 &&
      key.length <= 64 &&
      key !== "localUrl" &&
      key !== "fileUrl" &&
      typeof entryValue === "string" &&
      entryValue.length <= 4096
    )
    .slice(0, 20) as [string, string][];
  return entries.length ? Object.fromEntries(entries) : undefined;
};

const notifyPresence = (userId: string, isOnline: boolean) => {
  const payload = JSON.stringify({
    type: "presence",
    payload: { userId, isOnline, lastSeen: onlineUsers.get(userId) }
  });
  const subs = contactSubscriptions.get(userId);
  if (subs) {
    for (const subId of subs) {
      const legacy = clients.get(subId);
      if (legacy) safeSend(legacy.socket, payload);
      for (const c of deviceClients.values()) {
        if (c.userId === subId) safeSend(c.socket, payload);
      }
    }
  }
};

const subscribeToContact = (userId: string, contactId: string) => {
  let subs = contactSubscriptions.get(contactId);
  if (!subs) {
    subs = new Set();
    contactSubscriptions.set(contactId, subs);
  }
  subs.add(userId);
};

export const attachWebSocket = (server: import("http").Server) => {
  const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    const deviceIdParam = url.searchParams.get("deviceId") ?? undefined;
    const userId = token ? verifyToken(token) : null;
    if (!userId || !db.findUserById(userId)) {
      socket.close(4001, "unauthorized");
      return;
    }

    let deviceId: string | undefined;
    if (deviceIdParam) {
      const device = db.findDeviceForUser(userId, deviceIdParam);
      if (!device || device.status !== "active") {
        socket.close(4003, "device_not_registered");
        return;
      }
      deviceId = device.id;
      db.touchDevice(userId, deviceId);
      const prevDevice = deviceClients.get(deviceId);
      if (prevDevice && prevDevice.socket !== socket && prevDevice.socket.readyState === WebSocket.OPEN) {
        prevDevice.socket.close(4002, "device_replaced");
      }
      deviceClients.set(deviceId, { userId, deviceId, socket });
    } else {
      const prev = clients.get(userId);
      if (prev && prev.socket !== socket && prev.socket.readyState === WebSocket.OPEN) {
        prev.socket.close(4002, "replaced");
      }
      clients.set(userId, { userId, socket });
    }

    onlineUsers.set(userId, new Date().toISOString());
    notifyPresence(userId, true);

    socket.on("message", (raw) => {
      if (!checkWsRate(userId)) {
        sendError(socket, "rate_limited");
        return;
      }

      try {
        const data = raw.toString();
        if (data.length > MAX_WS_JSON_BYTES) {
          sendError(socket, "payload_too_large");
          return;
        }

        const parsed = JSON.parse(data) as unknown;
        if (!isRecord(parsed) || !isBoundedString(parsed.type, 64) || !isRecord(parsed.payload)) {
          return;
        }

        const { type, payload } = parsed;

        if (type === "message.send") {
          const to = payload.to;
          const id = payload.id;
          const contentType = payload.contentType;
          if (!isSafeId(to) || !isSafeId(id) || !contentTypes.has(contentType as MessageRecord["contentType"])) {
            sendError(socket, "message_invalid");
            return;
          }
          if (!db.findUserById(to)) {
            sendError(socket, "peer_not_found");
            return;
          }
          const nonce = optionalString(payload.nonce, 512);
          const ciphertext = optionalString(payload.ciphertext, 262_144);
          const selfNonce = optionalString(payload.selfNonce, 512);
          const selfCiphertext = optionalString(payload.selfCiphertext, 262_144);
          const senderPublicKey = optionalString(payload.senderPublicKey, 512);
          const body = optionalBodyString(payload.body, 262_144);
          const hasEncryptedPayload = Boolean(nonce && ciphertext && selfNonce && selfCiphertext && senderPublicKey);
          const hasCloudPayload = CHAT_MODE === "cloud" && body !== undefined;
          if (!hasCloudPayload && !hasEncryptedPayload) {
            sendError(socket, "message_encryption_required");
            return;
          }

          const meta = sanitizeMeta(payload.meta);
          if (contentType === "file") {
            if (!isSafeId(meta?.fileId)) {
              sendError(socket, "file_id_required");
              return;
            }
            const file = db.findFileById(meta.fileId);
            if (!file || file.ownerId !== userId || file.peerId !== to) {
              sendError(socket, "file_forbidden");
              return;
            }
          }

          const replyToId = optionalString(payload.replyToId, 128);
          if (replyToId && !db.getMessageInConversation(replyToId, userId, to)) {
            sendError(socket, "reply_invalid");
            return;
          }

          subscribeToContact(userId, to);
          subscribeToContact(to, userId);

          const deliveredAt = hasUserConnection(to) ? new Date().toISOString() : undefined;
          const message: MessageRecord = {
            id,
            from: userId,
            to,
            createdAt: parseCreatedAt(payload.createdAt),
            contentType: contentType as MessageRecord["contentType"],
            ...(hasCloudPayload ? { body } : {}),
            ...(hasEncryptedPayload ? { nonce, ciphertext, selfNonce, selfCiphertext, senderPublicKey } : {}),
            ...(deliveredAt ? { deliveredAt } : {}),
            ...(replyToId ? { replyToId } : {}),
            ...(meta ? { meta } : {})
          };

          try {
            db.saveMessage(message);
          } catch {
            sendError(socket, "message_not_saved");
            return;
          }

          sendToUser(to, { type: "message.receive", payload: message });
          if (deliveredAt) {
            safeSend(socket, JSON.stringify({ type: "message.delivered", payload: { id, deliveredAt } }));
          }
          return;
        }

        if (type === "typing") {
          const to = payload.to;
          if (!isSafeId(to) || !db.findUserById(to)) return;
          sendToUser(to, { type: "typing", payload: { from: userId } });
          return;
        }

        if (type === "message.delete") {
          const id = payload.id;
          const peerId = payload.peerId;
          if (!isSafeId(id) || !isSafeId(peerId)) return;
          const deleted = db.deleteOwnMessageForEveryone(id, userId, peerId);
          if (!deleted) return;
          const out = { type: "message.deleted", payload: { id, from: userId } };
          sendToUser(peerId, out);
          safeSend(socket, JSON.stringify(out));
          return;
        }

        if (type === "message.edit") {
          const id = payload.id;
          const peerId = payload.peerId;
          if (!isSafeId(id) || !isSafeId(peerId)) return;
          const nonce = optionalString(payload.nonce, 512);
          const ciphertext = optionalString(payload.ciphertext, 262_144);
          const selfNonce = optionalString(payload.selfNonce, 512);
          const selfCiphertext = optionalString(payload.selfCiphertext, 262_144);
          const senderPublicKey = optionalString(payload.senderPublicKey, 512);
          const body = optionalBodyString(payload.body, 262_144);
          const hasEncryptedPayload = Boolean(nonce && ciphertext && selfNonce && selfCiphertext && senderPublicKey);
          const hasCloudPayload = CHAT_MODE === "cloud" && body !== undefined;
          if (!hasCloudPayload && !hasEncryptedPayload) return;
          const updated = db.editMessage(id, userId, peerId, hasCloudPayload
            ? { body, ciphertext: undefined, nonce: undefined, selfCiphertext: undefined, selfNonce: undefined, senderPublicKey: undefined }
            : { ciphertext, nonce, selfCiphertext, selfNonce, senderPublicKey });
          if (updated) {
            const out = JSON.stringify({ type: "message.edited", payload: updated });
            sendToUser(peerId, JSON.parse(out) as ServerEvent);
            safeSend(socket, out);
          }
          return;
        }

        if (type === "message.pin") {
          const id = payload.id;
          const peerId = payload.peerId;
          if (!isSafeId(id) || !isSafeId(peerId)) return;
          const updated = db.togglePin(id, userId, peerId);
          if (updated) {
            const out = { type: "message.pinned", payload: { id, pinned: updated.pinned } };
            sendToUser(peerId, out);
            safeSend(socket, JSON.stringify(out));
          }
          return;
        }

        if (type === "message.react") {
          const id = payload.id;
          const peerId = payload.peerId;
          const emoji = payload.emoji;
          if (!isSafeId(id) || !isSafeId(peerId) || !isBoundedString(emoji, 32)) return;
          const updated = db.addReaction(id, userId, peerId, emoji);
          if (updated) {
            const out = { type: "message.reacted", payload: { id, reactions: updated.reactions } };
            sendToUser(peerId, out);
            safeSend(socket, JSON.stringify(out));
          }
          return;
        }

        if (type === "call.offer" || type === "call.answer" || type === "call.ice" || type === "call.end") {
          if (!isRecord(payload)) return;
          const to = payload.to;
          if (!isSafeId(to) || !db.findUserById(to)) return;
          sendToUser(to, { type, payload: { ...payload, from: userId } });
          return;
        }

        if (type === "status.update") {
          if (!isBoundedString(payload.status, 200)) return;
          const user = db.findUserById(userId);
          if (user) {
            user.status = payload.status;
            db.saveUser(user);
          }
          return;
        }

        if (type === "message.read") {
          const peerId = payload.peerId;
          const ids = payload.ids;
          if (!isSafeId(peerId) || !Array.isArray(ids) || ids.length === 0 || ids.length > 100) return;
          const cleanIds = ids.filter(isSafeId);
          if (!cleanIds.length) return;
          const result = db.markMessagesRead(userId, peerId, cleanIds);
          if (result.ids.length) {
            sendToUser(peerId, { type: "message.read", payload: { ids: result.ids, readAt: result.readAt } });
          }
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        console.error(`[WS] Error processing message from ${userId}:`, (err as Error).message);
      }
    });

    socket.on("close", () => {
      const current = clients.get(userId);
      if (current && current.socket === socket) {
        clients.delete(userId);
      }
      if (deviceId) {
        const currentDevice = deviceClients.get(deviceId);
        if (currentDevice && currentDevice.socket === socket) {
          deviceClients.delete(deviceId);
        }
      }
      if (!hasUserConnection(userId)) {
        onlineUsers.set(userId, new Date().toISOString());
        notifyPresence(userId, false);
      }
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of wsRateLimits) {
      if (now > v.resetAt) wsRateLimits.delete(k);
    }
  }, 30_000);
};

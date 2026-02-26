import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { db } from "./store.js";

export type SocketClient = {
  userId: string;
  socket: import("ws").WebSocket;
};

const clients = new Map<string, SocketClient>();
const onlineUsers = new Map<string, string>();
const contactSubscriptions = new Map<string, Set<string>>();
const wsRateLimits = new Map<string, { count: number; resetAt: number }>();

const WS_RATE_LIMIT = 60;
const WS_RATE_WINDOW = 10_000;

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

const safeSend = (socket: import("ws").WebSocket, data: string) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(data);
  }
};

const notifyPresence = (userId: string, isOnline: boolean) => {
  const payload = JSON.stringify({
    type: "presence",
    payload: { userId, isOnline, lastSeen: onlineUsers.get(userId) }
  });
  const subs = contactSubscriptions.get(userId);
  if (subs) {
    for (const subId of subs) {
      const c = clients.get(subId);
      if (c) safeSend(c.socket, payload);
    }
  }
};

const subscribeToContact = (userId: string, contactId: string) => {
  let subs = contactSubscriptions.get(contactId);
  if (!subs) { subs = new Set(); contactSubscriptions.set(contactId, subs); }
  subs.add(userId);
};

export const attachWebSocket = (server: import("http").Server) => {
  const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    const userId = token ? verifyToken(token) : null;
    if (!userId) { socket.close(4001, "unauthorized"); return; }

    const prev = clients.get(userId);
    if (prev && prev.socket !== socket && prev.socket.readyState === prev.socket.OPEN) {
      prev.socket.close(4002, "replaced");
    }

    clients.set(userId, { userId, socket });
    onlineUsers.set(userId, new Date().toISOString());
    notifyPresence(userId, true);

    socket.on("message", (raw) => {
      if (!checkWsRate(userId)) {
        safeSend(socket, JSON.stringify({ type: "error", payload: { message: "rate_limited" } }));
        return;
      }

      try {
        const data = raw.toString();
        if (data.length > 512_000) return;

        const { type, payload } = JSON.parse(data);
        if (!type || typeof type !== "string" || !payload) return;

        if (type === "message.send") {
          if (!payload.to || !payload.id || !payload.createdAt) return;

          subscribeToContact(userId, payload.to);
          subscribeToContact(payload.to, userId);

          const deliveredAt = clients.get(payload.to) ? new Date().toISOString() : undefined;
          const message = { ...payload, from: userId, deliveredAt };
          db.saveMessage(message);

          const target = clients.get(payload.to);
          if (target) {
            safeSend(target.socket, JSON.stringify({ type: "message.receive", payload: message }));
          }
          if (deliveredAt) {
            safeSend(socket, JSON.stringify({ type: "message.delivered", payload: { id: payload.id, deliveredAt } }));
          }
        }

        if (type === "typing") {
          if (!payload.to) return;
          const target = clients.get(payload.to);
          if (target) safeSend(target.socket, JSON.stringify({ type: "typing", payload: { from: userId } }));
        }

        if (type === "message.delete") {
          if (!payload.id) return;
          db.deleteMessage(payload.id, userId);
          const target = clients.get(payload.peerId);
          if (target) safeSend(target.socket, JSON.stringify({ type: "message.deleted", payload: { id: payload.id, from: userId } }));
        }

        if (type === "message.edit") {
          if (!payload.id || !payload.peerId) return;
          const updated = db.editMessage(payload.id, userId, {
            ciphertext: payload.ciphertext, nonce: payload.nonce,
            selfCiphertext: payload.selfCiphertext, selfNonce: payload.selfNonce,
            senderPublicKey: payload.senderPublicKey
          });
          if (updated) {
            const out = JSON.stringify({ type: "message.edited", payload: { ...updated, from: userId } });
            const target = clients.get(payload.peerId);
            if (target) safeSend(target.socket, out);
            safeSend(socket, out);
          }
        }

        if (type === "message.pin") {
          if (!payload.id || !payload.peerId) return;
          const updated = db.togglePin(payload.id, userId);
          if (updated) {
            const out = JSON.stringify({ type: "message.pinned", payload: { id: payload.id, pinned: updated.pinned } });
            const target = clients.get(payload.peerId);
            if (target) safeSend(target.socket, out);
            safeSend(socket, out);
          }
        }

        if (type === "message.react") {
          if (!payload.id || !payload.peerId || !payload.emoji) return;
          const updated = db.addReaction(payload.id, userId, payload.emoji);
          if (updated) {
            const out = JSON.stringify({ type: "message.reacted", payload: { id: payload.id, reactions: updated.reactions } });
            const target = clients.get(payload.peerId);
            if (target) safeSend(target.socket, out);
            safeSend(socket, out);
          }
        }

        if (type === "call.offer" || type === "call.answer" || type === "call.ice" || type === "call.end") {
          if (!payload.to) return;
          const target = clients.get(payload.to);
          if (target) safeSend(target.socket, JSON.stringify({ type, payload: { ...payload, from: userId } }));
        }

        if (type === "status.update") {
          if (!payload.status || typeof payload.status !== "string") return;
          const user = db.findUserById(userId);
          if (user) { user.status = payload.status.slice(0, 200); db.saveUser(user); }
        }

        if (type === "message.read") {
          const ids = payload.ids;
          if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) return;
          const readAt = new Date().toISOString();
          db.updateMessages(ids, { readAt, deliveredAt: readAt });
          const target = clients.get(payload.peerId);
          if (target) safeSend(target.socket, JSON.stringify({ type: "message.read", payload: { ids, readAt } }));
        }
      } catch {
        // malformed
      }
    });

    socket.on("close", () => {
      const current = clients.get(userId);
      if (current && current.socket === socket) {
        clients.delete(userId);
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

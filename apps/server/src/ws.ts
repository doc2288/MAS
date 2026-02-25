import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { db } from "./store.js";

export type SocketClient = {
  userId: string;
  socket: import("ws").WebSocket;
};

const clients = new Map<string, SocketClient>();
const onlineUsers = new Map<string, string>(); // userId -> lastSeen ISO

const safeSend = (socket: import("ws").WebSocket, data: string) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(data);
  }
};

const broadcastPresence = (userId: string, isOnline: boolean) => {
  const payload = JSON.stringify({
    type: "presence",
    payload: { userId, isOnline, lastSeen: onlineUsers.get(userId) }
  });
  for (const client of clients.values()) {
    safeSend(client.socket, payload);
  }
};

export const attachWebSocket = (server: import("http").Server) => {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    const userId = token ? verifyToken(token) : null;
    if (!userId) {
      socket.close();
      return;
    }

    const prev = clients.get(userId);
    if (prev && prev.socket !== socket && prev.socket.readyState === prev.socket.OPEN) {
      prev.socket.close();
    }

    clients.set(userId, { userId, socket });
    onlineUsers.set(userId, new Date().toISOString());
    broadcastPresence(userId, true);

    socket.on("message", (raw) => {
      try {
        const { type, payload } = JSON.parse(raw.toString());
        if (!type || !payload) return;

        if (type === "message.send") {
          const deliveredAt = clients.get(payload.to)
            ? new Date().toISOString()
            : undefined;
          const message = {
            ...payload,
            from: userId,
            deliveredAt
          };
          db.saveMessage(message);
          const target = clients.get(payload.to);
          if (target) {
            safeSend(
              target.socket,
              JSON.stringify({ type: "message.receive", payload: message })
            );
          }
          if (deliveredAt) {
            const sender = clients.get(userId);
            if (sender) {
              safeSend(
                sender.socket,
                JSON.stringify({
                  type: "message.delivered",
                  payload: { id: payload.id, deliveredAt }
                })
              );
            }
          }
        }

        if (type === "typing") {
          const target = clients.get(payload.to);
          if (target) {
            safeSend(
              target.socket,
              JSON.stringify({ type: "typing", payload: { from: userId } })
            );
          }
        }

        if (type === "message.delete") {
          const msgId = payload.id as string;
          if (msgId) {
            db.deleteMessage(msgId, userId);
            const target = clients.get(payload.peerId);
            if (target) {
              safeSend(
                target.socket,
                JSON.stringify({ type: "message.deleted", payload: { id: msgId, from: userId } })
              );
            }
          }
        }

        if (type === "message.edit") {
          const updated = db.editMessage(payload.id, userId, {
            ciphertext: payload.ciphertext,
            nonce: payload.nonce,
            selfCiphertext: payload.selfCiphertext,
            selfNonce: payload.selfNonce,
            senderPublicKey: payload.senderPublicKey
          });
          if (updated) {
            const out = { type: "message.edited", payload: { ...updated, from: userId } };
            const target = clients.get(payload.peerId);
            if (target) safeSend(target.socket, JSON.stringify(out));
            const sender = clients.get(userId);
            if (sender) safeSend(sender.socket, JSON.stringify(out));
          }
        }

        if (type === "message.pin") {
          const updated = db.togglePin(payload.id, userId);
          if (updated) {
            const out = { type: "message.pinned", payload: { id: payload.id, pinned: updated.pinned } };
            const target = clients.get(payload.peerId);
            if (target) safeSend(target.socket, JSON.stringify(out));
            const sender = clients.get(userId);
            if (sender) safeSend(sender.socket, JSON.stringify(out));
          }
        }

        if (type === "message.react") {
          const updated = db.addReaction(payload.id, userId, payload.emoji);
          if (updated) {
            const out = { type: "message.reacted", payload: { id: payload.id, reactions: updated.reactions } };
            const target = clients.get(payload.peerId);
            if (target) safeSend(target.socket, JSON.stringify(out));
            const sender = clients.get(userId);
            if (sender) safeSend(sender.socket, JSON.stringify(out));
          }
        }

        if (
          type === "call.offer" ||
          type === "call.answer" ||
          type === "call.ice" ||
          type === "call.end"
        ) {
          const target = clients.get(payload.to);
          if (target) {
            safeSend(
              target.socket,
              JSON.stringify({ type, payload: { ...payload, from: userId } })
            );
          }
        }

        if (type === "status.update") {
          const user = db.findUserById(userId);
          if (user) {
            user.status = payload.status;
            db.saveUser(user);
          }
        }
        if (type === "message.read") {
          const ids = payload.ids as string[];
          if (Array.isArray(ids) && ids.length > 0) {
            const readAt = new Date().toISOString();
            db.updateMessages(ids, { readAt, deliveredAt: readAt });
            const target = clients.get(payload.peerId);
            if (target) {
              safeSend(
                target.socket,
                JSON.stringify({
                  type: "message.read",
                  payload: { ids, readAt }
                })
              );
            }
          }
        }
      } catch {
        // ignore malformed packets
      }
    });

    socket.on("close", () => {
      const current = clients.get(userId);
      if (current && current.socket === socket) {
        clients.delete(userId);
        onlineUsers.set(userId, new Date().toISOString());
        broadcastPresence(userId, false);
      }
    });
  });
};

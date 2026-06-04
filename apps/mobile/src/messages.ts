import { decryptMessage, encryptMessage } from "@mas/shared";
import type { ChatMode, KeyPairState, UiMessage, User } from "./types";

export const tryDecrypt = (
  nonce: string | undefined,
  ciphertext: string | undefined,
  senderPublicKey: string | undefined,
  recipientSecretKey: string | undefined
) => {
  if (!nonce || !ciphertext || !senderPublicKey || !recipientSecretKey) return undefined;
  try {
    return decryptMessage(nonce, ciphertext, senderPublicKey, recipientSecretKey) ?? undefined;
  } catch {
    return undefined;
  }
};

export const decryptIncomingMessage = (
  payload: any,
  currentUserId: string,
  keys: KeyPairState | null,
  peer?: User | null,
  chatMode: ChatMode = "cloud"
): UiMessage => {
  const isMine = payload.from === currentUserId;
  const contentType = payload.contentType as UiMessage["contentType"];
  if (typeof payload.body === "string") {
    const status = isMine
      ? payload.readAt ? "read" : payload.deliveredAt ? "delivered" : "sent"
      : undefined;
    return {
      id: String(payload.id),
      from: String(payload.from),
      to: String(payload.to),
      createdAt: String(payload.createdAt ?? new Date().toISOString()),
      contentType,
      text: payload.body,
      meta: payload.meta ?? {},
      isMine,
      status: status as UiMessage["status"],
      replyToId: payload.replyToId,
      editedAt: payload.editedAt,
      pinned: payload.pinned,
      reactions: payload.reactions,
    };
  }
  if (!keys) {
    return {
      id: String(payload.id),
      from: String(payload.from),
      to: String(payload.to),
      createdAt: String(payload.createdAt ?? new Date().toISOString()),
      contentType,
      text: chatMode === "cloud" ? "Old encrypted message cannot be recovered" : "Locked: no local encryption keys",
      meta: { ...(payload.meta ?? {}), ...(chatMode === "cloud" ? { legacyUnrecoverable: "true" } : { decryptFailed: "true" }) },
      isMine,
    };
  }

  let text: string | undefined;
  let decryptFailed = false;
  text = tryDecrypt(payload.selfNonce, payload.selfCiphertext, keys.publicKey, keys.secretKey);
  if (!text) text = tryDecrypt(payload.nonce, payload.ciphertext, payload.senderPublicKey, keys.secretKey);
  if (!text) text = tryDecrypt(payload.nonce, payload.ciphertext, peer?.publicKey, keys.secretKey);
  if (!text) text = tryDecrypt(payload.nonce, payload.ciphertext, keys.publicKey, keys.secretKey);
  if (!text && contentType === "text") {
    text = chatMode === "cloud" ? "Old encrypted message cannot be recovered" : "Locked: encrypted with another key";
    decryptFailed = chatMode !== "cloud";
  }

  const status = isMine
    ? payload.readAt ? "read" : payload.deliveredAt ? "delivered" : "sent"
    : undefined;

  return {
    id: String(payload.id),
    from: String(payload.from),
    to: String(payload.to),
    createdAt: String(payload.createdAt ?? new Date().toISOString()),
    contentType,
    text,
    meta: {
      ...(payload.meta ?? {}),
      ...(payload.senderPublicKey ? { senderPublicKey: payload.senderPublicKey } : {}),
      ...(decryptFailed ? { decryptFailed: "true" } : {}),
    },
    isMine,
    status: status as UiMessage["status"],
    replyToId: payload.replyToId,
    editedAt: payload.editedAt,
    pinned: payload.pinned,
    reactions: payload.reactions,
  };
};

export const buildCloudMessagePayload = (
  id: string,
  to: string,
  contentType: UiMessage["contentType"],
  body: string,
  meta?: Record<string, string>,
  replyToId?: string
) => ({
  id,
  to,
  createdAt: new Date().toISOString(),
  contentType,
  body,
  meta,
  ...(replyToId ? { replyToId } : {}),
});

export const buildEncryptedMessagePayload = (
  id: string,
  to: string,
  contentType: UiMessage["contentType"],
  text: string,
  keys: KeyPairState,
  recipientPublicKey: string,
  meta?: Record<string, string>,
  replyToId?: string
) => {
  const createdAt = new Date().toISOString();
  const encrypted = encryptMessage(text, keys.secretKey, recipientPublicKey);
  const selfEncrypted = encryptMessage(text, keys.secretKey, keys.publicKey);
  return {
    id,
    to,
    createdAt,
    contentType,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    senderPublicKey: keys.publicKey,
    selfNonce: selfEncrypted.nonce,
    selfCiphertext: selfEncrypted.ciphertext,
    meta,
    ...(replyToId ? { replyToId } : {}),
  };
};

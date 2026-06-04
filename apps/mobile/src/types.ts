import type { MediaStream, RTCPeerConnection } from "react-native-webrtc";

export type User = {
  id: string;
  phone: string;
  login?: string;
  publicKey?: string;
  status?: string;
};

export type QrPayload = {
  qrSessionId: string;
  secret: string;
};

export type KeyPairState = {
  publicKey: string;
  secretKey: string;
};

export type ChatMode = "cloud" | "legacy";

export type KeyBackupPayload = {
  ciphertext: string;
  salt: string;
  nonce: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  updatedAt?: string;
};

export type KeyBackupResponse = {
  publicKey: string;
  backup: KeyBackupPayload;
};

export type UiMessage = {
  id: string;
  from: string;
  to: string;
  createdAt: string;
  contentType: "text" | "file" | "emoji" | "sticker" | "gif" | "voice" | "call";
  text?: string;
  meta?: Record<string, string>;
  isMine: boolean;
  status?: "sent" | "delivered" | "read";
  replyToId?: string;
  editedAt?: string;
  pinned?: boolean;
  reactions?: Record<string, string[]>;
};

export type ChatSummary = {
  peerId: string;
  peerPhone: string;
  peerLogin?: string;
  peerPublicKey?: string;
  lastMessageAt: string;
  lastContentType: UiMessage["contentType"];
};

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type SessionDescriptionInit = {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
};

export type IceCandidateInit = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

export type CallState = {
  status: "idle" | "calling" | "incoming" | "in-call";
  peerId?: string;
  callerId?: string;
  offer?: SessionDescriptionInit;
  pc?: RTCPeerConnection;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  isVideo?: boolean;
  muted?: boolean;
  cameraOff?: boolean;
};

export type KeyStatus =
  | { state: "ready" }
  | { state: "checking" }
  | { state: "restore-required"; backupAvailable: boolean; serverPublicKey: string }
  | { state: "blocked"; reason: string };

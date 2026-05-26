import nacl from "tweetnacl";
import { decodeUTF8, encodeBase64, decodeBase64, encodeUTF8 } from "tweetnacl-util";

export type KeyPair = {
  publicKey: string;
  secretKey: string;
};

export const generateKeyPair = (): KeyPair => {
  const pair = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(pair.publicKey),
    secretKey: encodeBase64(pair.secretKey)
  };
};

export const encryptMessage = (
  message: string,
  senderSecretKey: string,
  recipientPublicKey: string
) => {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    decodeUTF8(message),
    nonce,
    decodeBase64(recipientPublicKey),
    decodeBase64(senderSecretKey)
  );
  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext)
  };
};

export const decryptMessage = (
  nonce: string,
  ciphertext: string,
  senderPublicKey: string,
  recipientSecretKey: string
) => {
  const decrypted = nacl.box.open(
    decodeBase64(ciphertext),
    decodeBase64(nonce),
    decodeBase64(senderPublicKey),
    decodeBase64(recipientSecretKey)
  );
  if (!decrypted) {
    return null;
  }
  return encodeUTF8(decrypted);
};

export const encryptBytes = (
  bytes: Uint8Array,
  senderSecretKey: string,
  recipientPublicKey: string
) => {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    bytes,
    nonce,
    decodeBase64(recipientPublicKey),
    decodeBase64(senderSecretKey)
  );
  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext)
  };
};

export const decryptBytes = (
  nonce: string,
  ciphertext: string,
  senderPublicKey: string,
  recipientSecretKey: string
) => {
  const decrypted = nacl.box.open(
    decodeBase64(ciphertext),
    decodeBase64(nonce),
    decodeBase64(senderPublicKey),
    decodeBase64(recipientSecretKey)
  );
  return decrypted ?? null;
};

export const toBase64 = (bytes: Uint8Array) => encodeBase64(bytes);
export const fromBase64 = (value: string) => decodeBase64(value);

export type SignalV2SignedPreKey = {
  keyId: number;
  publicKey: string;
  signature: string;
};

export type SignalV2OneTimePreKey = {
  keyId: number;
  publicKey: string;
};

export type SignalV2DeviceRegistration = {
  deviceId: string;
  label?: string;
  identityKey: string;
  registrationId: number;
  signedPreKey: SignalV2SignedPreKey;
  oneTimePreKeys: SignalV2OneTimePreKey[];
};

export type SignalV2PreKeyBundle = {
  userId: string;
  deviceId: string;
  identityKey: string;
  registrationId: number;
  signedPreKey: SignalV2SignedPreKey;
  oneTimePreKey?: SignalV2OneTimePreKey;
};

export type SignalV2PlaintextMessage = {
  contentType: "text" | "file" | "emoji" | "sticker" | "gif" | "call" | "voice";
  body?: string;
  file?: {
    fileId: string;
    key: string;
    nonce: string;
    name: string;
    mimeType?: string;
    size: number;
    sha256: string;
  };
  replyToId?: string;
  createdAt: string;
};

export type SignalV2Envelope = {
  id: string;
  recipientUserId: string;
  recipientDeviceId: string;
  envelopeType: "prekey" | "signal" | "retry";
  ciphertext: string;
  sessionId?: string;
  preKeyId?: number;
};

export type SignalV2SyncedEnvelope = SignalV2Envelope & {
  messageId: string;
  senderUserId: string;
  senderDeviceId: string;
  deviceSeq: number;
  createdAt: string;
};

export type SignalV2Runtime = {
  registerDevice(label?: string): Promise<SignalV2DeviceRegistration>;
  publishPreKeys(deviceId: string, count: number): Promise<SignalV2OneTimePreKey[]>;
  encryptForDevices(
    senderDeviceId: string,
    bundles: SignalV2PreKeyBundle[],
    message: SignalV2PlaintextMessage
  ): Promise<SignalV2Envelope[]>;
  decryptEnvelope(envelope: SignalV2SyncedEnvelope): Promise<SignalV2PlaintextMessage>;
  processRetryRequest(envelopeId: string): Promise<SignalV2Envelope | null>;
};

export const createUnavailableSignalV2Runtime = (reason = "Signal v2 crypto runtime is not configured"): SignalV2Runtime => ({
  async registerDevice(): Promise<SignalV2DeviceRegistration> {
    throw new Error(reason);
  },
  async publishPreKeys(): Promise<SignalV2OneTimePreKey[]> {
    throw new Error(reason);
  },
  async encryptForDevices(): Promise<SignalV2Envelope[]> {
    throw new Error(reason);
  },
  async decryptEnvelope(): Promise<SignalV2PlaintextMessage> {
    throw new Error(reason);
  },
  async processRetryRequest(): Promise<SignalV2Envelope | null> {
    throw new Error(reason);
  },
});

export const registerDevice = (runtime: SignalV2Runtime, label?: string) =>
  runtime.registerDevice(label);

export const publishPreKeys = (runtime: SignalV2Runtime, deviceId: string, count = 100) =>
  runtime.publishPreKeys(deviceId, count);

export const claimPreKeyBundles = async (
  fetcher: typeof fetch,
  token: string,
  apiUrl: string,
  userIds: string[],
  excludeDeviceId?: string
): Promise<SignalV2PreKeyBundle[]> => {
  const res = await fetcher(`${apiUrl}/prekey-bundles/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userIds, excludeDeviceId }),
  });
  if (!res.ok) throw new Error(`prekey_bundle_claim_failed:${res.status}`);
  const data = (await res.json()) as { bundles?: SignalV2PreKeyBundle[] };
  return data.bundles ?? [];
};

export const encryptForDevices = (
  runtime: SignalV2Runtime,
  senderDeviceId: string,
  bundles: SignalV2PreKeyBundle[],
  message: SignalV2PlaintextMessage
) => runtime.encryptForDevices(senderDeviceId, bundles, message);

export const decryptEnvelope = (runtime: SignalV2Runtime, envelope: SignalV2SyncedEnvelope) =>
  runtime.decryptEnvelope(envelope);

export const processRetryRequest = (runtime: SignalV2Runtime, envelopeId: string) =>
  runtime.processRetryRequest(envelopeId);

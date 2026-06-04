import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64, generateKeyPair, toBase64 } from "@mas/shared";
import { decodeUTF8, encodeUTF8 } from "tweetnacl-util";
import { authHeaders, jsonHeaders } from "./api";
import { loadStoredKeys, saveStoredKeys } from "./storage";
import type { KeyBackupPayload, KeyBackupResponse, KeyPairState, KeyStatus, User } from "./types";

const KEY_BACKUP_ITERATIONS = 210_000;

const randomBytes = (length: number) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const deriveBackupKey = (pin: string, salt: Uint8Array, iterations: number) =>
  pbkdf2(sha256, decodeUTF8(pin), salt, { c: iterations, dkLen: 32 });

export const createKeyBackupPayload = (keys: KeyPairState, pin: string): KeyBackupPayload => {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveBackupKey(pin, salt, KEY_BACKUP_ITERATIONS);
  const ciphertext = gcm(key, nonce).encrypt(decodeUTF8(keys.secretKey));
  return {
    ciphertext: toBase64(ciphertext),
    salt: toBase64(salt),
    nonce: toBase64(nonce),
    kdf: "PBKDF2-SHA256",
    iterations: KEY_BACKUP_ITERATIONS,
  };
};

export const restoreKeysFromBackup = (
  publicKey: string,
  backup: KeyBackupPayload,
  pin: string
): KeyPairState => {
  const key = deriveBackupKey(pin, fromBase64(backup.salt), backup.iterations);
  const plaintext = gcm(key, fromBase64(backup.nonce)).decrypt(fromBase64(backup.ciphertext));
  return { publicKey, secretKey: encodeUTF8(plaintext) };
};

export const fetchKeyBackup = async (apiUrl: string, token: string) => {
  const res = await fetch(`${apiUrl}/keys/backup`, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("backup_fetch_failed");
  return (await res.json()) as KeyBackupResponse;
};

export const saveKeyBackup = async (apiUrl: string, token: string, keys: KeyPairState, pin: string) => {
  const backup = createKeyBackupPayload(keys, pin);
  const res = await fetch(`${apiUrl}/keys/backup`, {
    method: "PUT",
    headers: jsonHeaders(token),
    body: JSON.stringify({ publicKey: keys.publicKey, backup }),
  });
  if (!res.ok) throw new Error("backup_save_failed");
};

export const publishPublicKey = async (apiUrl: string, token: string, publicKey: string) => {
  const res = await fetch(`${apiUrl}/keys`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ publicKey }),
  });
  if (!res.ok) throw new Error("key_publish_failed");
};

export const initializeKeys = async (
  apiUrl: string,
  token: string,
  user: User
): Promise<{ keys: KeyPairState | null; status: KeyStatus; user: User }> => {
  const localKeys = await loadStoredKeys();
  if (localKeys && (!user.publicKey || localKeys.publicKey === user.publicKey)) {
    if (!user.publicKey) {
      await publishPublicKey(apiUrl, token, localKeys.publicKey);
      return { keys: localKeys, status: { state: "ready" }, user: { ...user, publicKey: localKeys.publicKey } };
    }
    return { keys: localKeys, status: { state: "ready" }, user };
  }

  if (user.publicKey) {
    const backup = await fetchKeyBackup(apiUrl, token).catch(() => null);
    return {
      keys: null,
      status: { state: "restore-required", backupAvailable: Boolean(backup), serverPublicKey: user.publicKey },
      user,
    };
  }

  const keys = generateKeyPair();
  await saveStoredKeys(keys);
  await publishPublicKey(apiUrl, token, keys.publicKey);
  return { keys, status: { state: "ready" }, user: { ...user, publicKey: keys.publicKey } };
};

export const restoreAndStoreKeys = async (apiUrl: string, token: string, pin: string) => {
  const backup = await fetchKeyBackup(apiUrl, token);
  if (!backup) throw new Error("backup_missing");
  const keys = restoreKeysFromBackup(backup.publicKey, backup.backup, pin);
  await saveStoredKeys(keys);
  return keys;
};

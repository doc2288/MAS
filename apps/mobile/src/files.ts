import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { decryptBytes, encryptBytes, fromBase64, toBase64 } from "@mas/shared";
import { authHeaders } from "./api";
import type { KeyPairState, UiMessage, User } from "./types";

const sanitizeFilename = (value: string) => value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 160) || "file";

export const pickDocument = () => DocumentPicker.getDocumentAsync({
  copyToCacheDirectory: true,
  multiple: false,
});

export const uploadEncryptedFile = async (
  apiUrl: string,
  token: string,
  peer: User,
  keys: KeyPairState
) => {
  const result = await pickDocument();
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  if (!peer.publicKey) throw new Error("peer_key_missing");
  const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
  const encrypted = encryptBytes(fromBase64(base64), keys.secretKey, peer.publicKey);
  const encryptedName = `${sanitizeFilename(asset.name ?? "file")}.enc`;
  const encryptedPath = `${FileSystem.cacheDirectory}${Date.now()}-${encryptedName}`;
  await FileSystem.writeAsStringAsync(encryptedPath, encrypted.ciphertext, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const form = new FormData();
  form.append("peerId", peer.id);
  form.append("file", {
    uri: encryptedPath,
    name: encryptedName,
    type: "application/octet-stream",
  } as any);

  const res = await fetch(`${apiUrl}/files`, {
    method: "POST",
    headers: authHeaders(token),
    body: form,
  });
  if (!res.ok) throw new Error("upload_failed");
  const data = (await res.json()) as { fileId?: string };
  if (!data.fileId) throw new Error("upload_failed");
  return {
    fileId: data.fileId,
    fileName: asset.name ?? "file",
    fileType: asset.mimeType ?? "application/octet-stream",
    nonce: encrypted.nonce,
  };
};

export const uploadCloudFile = async (
  apiUrl: string,
  token: string,
  peer: User
) => {
  const result = await pickDocument();
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const form = new FormData();
  form.append("peerId", peer.id);
  form.append("file", {
    uri: asset.uri,
    name: sanitizeFilename(asset.name ?? "file"),
    type: asset.mimeType ?? "application/octet-stream",
  } as any);

  const res = await fetch(`${apiUrl}/files`, {
    method: "POST",
    headers: authHeaders(token),
    body: form,
  });
  if (!res.ok) throw new Error("upload_failed");
  const data = (await res.json()) as { fileId?: string };
  if (!data.fileId) throw new Error("upload_failed");
  return {
    fileId: data.fileId,
    fileName: asset.name ?? "file",
    fileType: asset.mimeType ?? "application/octet-stream",
  };
};

export const shareCloudFile = async (
  apiUrl: string,
  token: string,
  msg: UiMessage
) => {
  const meta = msg.meta;
  if (!meta?.fileId) throw new Error("file_unavailable");
  const res = await fetch(`${apiUrl}/files/${meta.fileId}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error("file_unavailable");
  const buffer = new Uint8Array(await res.arrayBuffer());
  const outputName = sanitizeFilename(meta.fileName ?? "file");
  const outputPath = `${FileSystem.cacheDirectory}${Date.now()}-${outputName}`;
  await FileSystem.writeAsStringAsync(outputPath, toBase64(buffer), {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(outputPath, { mimeType: meta.fileType ?? "application/octet-stream" });
  }
  return outputPath;
};

export const decryptAndShareFile = async (
  apiUrl: string,
  token: string,
  msg: UiMessage,
  keys: KeyPairState,
  peer?: User | null
) => {
  const meta = msg.meta;
  if (!meta?.fileId || !meta.nonce) throw new Error("file_unavailable");
  const res = await fetch(`${apiUrl}/files/${meta.fileId}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error("file_unavailable");
  const buffer = new Uint8Array(await res.arrayBuffer());
  const senderPublicKey = meta.senderPublicKey ?? peer?.publicKey ?? keys.publicKey;
  const decrypted = decryptBytes(meta.nonce, toBase64(buffer), senderPublicKey, keys.secretKey);
  if (!decrypted) throw new Error("decrypt_failed");

  const outputName = sanitizeFilename(meta.fileName ?? "file");
  const outputPath = `${FileSystem.cacheDirectory}${Date.now()}-${outputName}`;
  await FileSystem.writeAsStringAsync(outputPath, toBase64(decrypted), {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(outputPath, { mimeType: meta.fileType ?? "application/octet-stream" });
  }
  return outputPath;
};

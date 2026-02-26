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

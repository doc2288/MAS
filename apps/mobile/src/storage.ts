import * as SecureStore from "expo-secure-store";
import { DEFAULT_API_URL, normalizeApiUrl } from "./api";
import type { KeyPairState } from "./types";

export const TOKEN_KEY = "mas.mobile.token";
export const API_URL_KEY = "mas.mobile.apiUrl";
export const KEYS_KEY = "mas.mobile.keys";

export const loadApiUrl = async () => {
  const saved = await SecureStore.getItemAsync(API_URL_KEY);
  return normalizeApiUrl(saved ?? "") ?? DEFAULT_API_URL;
};

export const saveApiUrl = (apiUrl: string) => SecureStore.setItemAsync(API_URL_KEY, apiUrl);

export const loadToken = () => SecureStore.getItemAsync(TOKEN_KEY);

export const saveToken = (token: string) => SecureStore.setItemAsync(TOKEN_KEY, token);

export const clearToken = () => SecureStore.deleteItemAsync(TOKEN_KEY);

export const loadStoredKeys = async (): Promise<KeyPairState | null> => {
  try {
    const raw = await SecureStore.getItemAsync(KEYS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KeyPairState>;
    if (typeof parsed.publicKey === "string" && typeof parsed.secretKey === "string") {
      return { publicKey: parsed.publicKey, secretKey: parsed.secretKey };
    }
  } catch {
    await SecureStore.deleteItemAsync(KEYS_KEY);
  }
  return null;
};

export const saveStoredKeys = (keys: KeyPairState) =>
  SecureStore.setItemAsync(KEYS_KEY, JSON.stringify(keys));

export const clearStoredKeys = () => SecureStore.deleteItemAsync(KEYS_KEY);

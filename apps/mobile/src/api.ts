import type { ChatMode, IceServer, QrPayload } from "./types";

export const DEFAULT_API_URL = "http://10.1.1.132:4000";
export const SERVER_URL_PLACEHOLDER = "https://your-name.asuscomm.com";
export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
export const DEFAULT_CHAT_MODE: ChatMode = "cloud";

export const normalizeApiUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
};

export const resolveWsUrl = (apiUrl: string) => {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
};

export const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

export const jsonHeaders = (token?: string): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(token ? authHeaders(token) : {}),
});

export const parseQrPayload = (value: string): QrPayload | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "mas-auth:" || url.hostname !== "qr") return null;
    const qrSessionId = url.searchParams.get("session");
    const secret = url.searchParams.get("secret");
    return qrSessionId && secret ? { qrSessionId, secret } : null;
  } catch {
    return null;
  }
};

const isIceServer = (value: unknown): value is IceServer => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  const urls = server.urls;
  const validUrls = typeof urls === "string" ||
    (Array.isArray(urls) && urls.length > 0 && urls.every((item) => typeof item === "string"));
  if (!validUrls) return false;
  if (server.username !== undefined && typeof server.username !== "string") return false;
  if (server.credential !== undefined && typeof server.credential !== "string") return false;
  return true;
};

export const readIceServers = (value: unknown): IceServer[] | null => {
  if (!Array.isArray(value)) return null;
  const servers = value.filter(isIceServer);
  return servers.length ? servers : null;
};

export const fetchClientConfig = async (apiUrl: string): Promise<{ chatMode: ChatMode }> => {
  try {
    const res = await fetch(`${apiUrl}/config/client`);
    if (!res.ok) return { chatMode: DEFAULT_CHAT_MODE };
    const data = (await res.json()) as { chatMode?: unknown };
    return { chatMode: data.chatMode === "legacy" ? "legacy" : "cloud" };
  } catch {
    return { chatMode: DEFAULT_CHAT_MODE };
  }
};

import { useEffect, useMemo, useRef, useState } from "react";
import {
  decryptBytes,
  decryptMessage,
  encryptBytes,
  encryptMessage,
  fromBase64,
  generateKeyPair,
  toBase64
} from "@mas/shared";
import {
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber
} from "libphonenumber-js";

type User = {
  id: string;
  phone: string;
  login?: string;
  publicKey?: string;
  status?: string;
};

type UiMessage = {
  id: string;
  from: string;
  to: string;
  createdAt: string;
  contentType: "text" | "file" | "emoji" | "sticker" | "gif";
  text?: string;
  meta?: Record<string, string>;
  isMine: boolean;
  status?: "sent" | "delivered" | "read";
};

type ChatSummary = {
  peerId: string;
  peerPhone: string;
  peerLogin?: string;
  peerPublicKey?: string;
  lastMessageAt: string;
  lastContentType: UiMessage["contentType"];
};

type CallState = {
  status: "idle" | "calling" | "incoming" | "in-call";
  offer?: RTCSessionDescriptionInit;
  callerId?: string;
  pc?: RTCPeerConnection;
  remoteStream?: MediaStream;
  localStream?: MediaStream;
  isVideo?: boolean;
};

const API_URL = "http://localhost:4000";
const WS_URL = "ws://localhost:4000";
const emojiList = ["😀", "🔥", "🚀", "💬", "✅", "🔒"];
const stickerList = ["sticker_wave", "sticker_heart", "sticker_party"];
const gifList = [
  "https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif",
  "https://media.giphy.com/media/l0HlNaQ6gWfllcjDO/giphy.gif"
];

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function App() {
  const defaultCountry = useMemo(() => {
    const region = navigator.language.split("-")[1] ?? "US";
    const available = getCountries();
    return available.includes(region as any) ? region : "US";
  }, []);
  const [country, setCountry] = useState(defaultCountry);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState("");
  const [localNumber, setLocalNumber] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [token, setToken] = useState<string | null>(localStorage.getItem("mas.token"));
  const [user, setUser] = useState<User | null>(null);
  const [keys, setKeys] = useState<{ publicKey: string; secretKey: string } | null>(
    () => {
      const raw = localStorage.getItem("mas.keys");
      return raw ? (JSON.parse(raw) as { publicKey: string; secretKey: string }) : null;
    }
  );
  const [peerPhone, setPeerPhone] = useState("");
  const [peer, setPeer] = useState<User | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [status, setStatus] = useState("");
  const [statusText, setStatusText] = useState("");
  const [activeTab, setActiveTab] = useState<"chat" | "settings">("chat");
  const [isMenuOpen, setIsMenuOpen] = useState(true);
  const [chatQuery, setChatQuery] = useState("");
  const [loginValue, setLoginValue] = useState("");
  const [loginMatches, setLoginMatches] = useState<User[]>([]);
  const [displayName, setDisplayName] = useState("MAS User");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [startOnBoot, setStartOnBoot] = useState(true);
  const [readReceipts, setReadReceipts] = useState(true);
  const [typingIndicator, setTypingIndicator] = useState(true);
  const [lastSeenVisible, setLastSeenVisible] = useState(true);
  const [call, setCall] = useState<CallState>({ status: "idle" });
  const wsRef = useRef<WebSocket | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const callWindowRef = useRef<Window | null>(null);
  const callWindowPartsRef = useRef<{
    localVideo?: HTMLVideoElement;
    remoteVideo?: HTMLVideoElement;
    label?: HTMLDivElement;
  } | null>(null);
  const toneCtxRef = useRef<AudioContext | null>(null);
  const toneOscRef = useRef<OscillatorNode | null>(null);
  const toneGainRef = useRef<GainNode | null>(null);
  const toneTimerRef = useRef<number | null>(null);
  const selectRef = useRef<HTMLDivElement | null>(null);
  const devices = [
    { name: "MAS Desktop", location: "Windows · Локально", lastActive: "Активний зараз" },
    { name: "MAS Web", location: "Chrome · Київ", lastActive: "2 хв тому" }
  ];
  const activityLog = [
    { title: "Вхід у акаунт", time: "Сьогодні, 09:12" },
    { title: "Зміна статусу", time: "Сьогодні, 09:05" },
    { title: "Надіслано файл", time: "Вчора, 21:40" }
  ];
  const chatItems = useMemo(() => {
    const labelForType = (type: UiMessage["contentType"]) => {
      switch (type) {
        case "file":
          return "Файл";
        case "gif":
          return "GIF";
        case "sticker":
          return "Стікер";
        case "emoji":
          return "Емодзі";
        case "call":
          return "Дзвінок";
        default:
          return "Зашифроване повідомлення";
      }
    };
    const items = chatList.map((item) => ({
      id: item.peerId,
      name: item.peerLogin ?? item.peerPhone,
      phone: item.peerPhone,
      lastMessage: labelForType(item.lastContentType),
      time: new Date(item.lastMessageAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      }),
      online: true,
      peerPublicKey: item.peerPublicKey
    }));
    if (!chatQuery.trim()) {
      return items;
    }
    const q = chatQuery.toLowerCase().trim();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.phone.toLowerCase().includes(q) ||
        item.lastMessage.toLowerCase().includes(q)
    );
  }, [chatList, chatQuery]);
  const countryOptions = useMemo(() => {
    const makeDisplay = (locale: string) => {
      try {
        return new Intl.DisplayNames([locale], { type: "region" });
      } catch {
        return null;
      }
    };
    const displayDefault = makeDisplay(navigator.language);
    const displayRu = makeDisplay("ru");
    const displayUk = makeDisplay("uk");
    const displayEn = makeDisplay("en");
    return getCountries()
      .map((item) => {
        const names = [
          displayDefault?.of(item),
          displayRu?.of(item),
          displayUk?.of(item),
          displayEn?.of(item)
        ].filter(Boolean) as string[];
        const name = names[0] ?? item;
        return {
          code: item,
          name,
          dial: getCountryCallingCode(item),
          search: `${names.join(" ")} ${item}`.toLowerCase()
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, []);
  const translitToLatin = (value: string) => {
    const map: Record<string, string> = {
      а: "a",
      б: "b",
      в: "v",
      г: "g",
      ґ: "g",
      д: "d",
      е: "e",
      ё: "yo",
      є: "ye",
      ж: "zh",
      з: "z",
      и: "i",
      і: "i",
      ї: "yi",
      й: "y",
      к: "k",
      л: "l",
      м: "m",
      н: "n",
      о: "o",
      п: "p",
      р: "r",
      с: "s",
      т: "t",
      у: "u",
      ф: "f",
      х: "kh",
      ц: "ts",
      ч: "ch",
      ш: "sh",
      щ: "shch",
      ъ: "",
      ы: "y",
      ь: "",
      э: "e",
      ю: "yu",
      я: "ya"
    };
    return value
      .split("")
      .map((char) => map[char] ?? char)
      .join("");
  };

  const filteredCountries = useMemo(() => {
    if (!countryQuery.trim()) {
      return countryOptions;
    }
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[().\-\s]/g, "")
        .trim();
    const q = normalize(countryQuery);
    const qLatin = normalize(translitToLatin(q));
    const qDigits = q.replace(/\D/g, "");
    return countryOptions.filter((item) => {
      const name = normalize(item.name);
      const nameLatin = normalize(translitToLatin(name));
      const search = normalize(item.search);
      const searchLatin = normalize(translitToLatin(search));
      const code = normalize(item.code);
      const dial = normalize(item.dial);
      return (
        name.includes(q) ||
        nameLatin.includes(q) ||
        name.includes(qLatin) ||
        nameLatin.includes(qLatin) ||
        search.includes(q) ||
        searchLatin.includes(q) ||
        search.includes(qLatin) ||
        searchLatin.includes(qLatin) ||
        code.includes(q) ||
        (qDigits.length > 0 && dial.includes(qDigits))
      );
    });
  }, [countryOptions, countryQuery]);
  const activeCountry = useMemo(
    () => countryOptions.find((item) => item.code === country),
    [countryOptions, country]
  );
  const dialCode = useMemo(() => getCountryCallingCode(country as any), [country]);
  const fullPhone = useMemo(() => {
    const digits = localNumber.replace(/\D/g, "");
    return `+${dialCode}${digits}`;
  }, [dialCode, localNumber]);

  const isAuthed = Boolean(token);

  const authHeaders = useMemo(
    () =>
      token
        ? {
            Authorization: `Bearer ${token}`
          }
        : {},
    [token]
  );

  const fetchChats = async () => {
    if (!token) {
      return;
    }
    const res = await fetch(`${API_URL}/chats`, { headers: authHeaders });
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as ChatSummary[];
    setChatList(data);
  };

  const saveLogin = async () => {
    if (!loginValue.trim()) {
      setStatus("Вкажіть логін.");
      return;
    }
    const res = await fetch(`${API_URL}/users/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders
      },
      body: JSON.stringify({ login: loginValue })
    });
    if (res.status === 409) {
      setStatus("Логін уже зайнятий.");
      return;
    }
    if (!res.ok) {
      setStatus("Не вдалося зберегти логін.");
      return;
    }
    const data = await res.json();
    setUser((prev) => (prev ? { ...prev, login: data.login } : prev));
    setStatus("Логін оновлено.");
  };

  const findUserByLogin = async () => {
    if (!chatQuery.trim()) {
      setLoginMatches([]);
      return;
    }
    if (chatQuery.trim().length < 3) {
      setLoginMatches([]);
      return;
    }
    const res = await fetch(
      `${API_URL}/users/search?query=${encodeURIComponent(chatQuery.trim())}`,
      { headers: authHeaders }
    );
    if (!res.ok) {
      setLoginMatches([]);
      return;
    }
    const data = (await res.json()) as User[];
    setLoginMatches(data);
  };

  useEffect(() => {
    if (!token) {
      return;
    }
    fetch(`${API_URL}/users/me`, { headers: authHeaders })
      .then((res) => res.json())
      .then((data) => {
        setUser(data);
        if (data?.login) {
          setLoginValue(data.login);
        }
      });
  }, [token, authHeaders]);

  useEffect(() => {
    fetchChats();
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }
    if (!keys) {
      const pair = generateKeyPair();
      localStorage.setItem("mas.keys", JSON.stringify(pair));
      setKeys(pair);
    }
  }, [token, keys]);

  useEffect(() => {
    if (!token || !keys) {
      return;
    }
    fetch(`${API_URL}/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders
      },
      body: JSON.stringify({ publicKey: keys.publicKey })
    });
  }, [token, keys, authHeaders]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const ws = initWebSocket();
    return () => ws?.close();
  }, [token, peer, call.pc]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!selectRef.current) {
        return;
      }
      if (!selectRef.current.contains(event.target as Node)) {
        setCountryOpen(false);
      }
    };
    if (countryOpen) {
      document.addEventListener("mousedown", handler);
    }
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, [countryOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      findUserByLogin();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [chatQuery, token]);

  useEffect(() => {
    if (!status) {
      return;
    }
    const timer = window.setTimeout(() => {
      setStatus("");
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const requestCode = async () => {
    if (!isValidPhoneNumber(fullPhone)) {
      setStatus("Невірний номер телефону.");
      return;
    }
    const res = await fetch(`${API_URL}/auth/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: fullPhone })
    });
    const data = await res.json();
    setDevCode(data.devCode ?? "");
    setStatus("Код надіслано (dev).");
  };

  const verifyCode = async () => {
    if (!isValidPhoneNumber(fullPhone)) {
      setStatus("Невірний номер телефону.");
      return;
    }
    const res = await fetch(`${API_URL}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: fullPhone, code })
    });
    const data = await res.json();
    if (data.token) {
      setToken(data.token);
      localStorage.setItem("mas.token", data.token);
      setUser(data.user);
      setStatus("Авторизація успішна.");
    } else {
      setStatus("Код невірний.");
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setPeer(null);
    setMessages([]);
    localStorage.removeItem("mas.token");
  };

  const initWebSocket = () => {
    if (!token) {
      return null;
    }
    if (
      wsRef.current &&
      wsRef.current.readyState !== WebSocket.CLOSED &&
      wsRef.current.readyState !== WebSocket.CLOSING
    ) {
      return wsRef.current;
    }
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("");
    };

    ws.onmessage = async (event) => {
      const { type, payload } = JSON.parse(event.data);
      if (type === "message.receive") {
        await handleIncomingMessage(payload);
        fetchChats();
      }
      if (type === "message.delivered") {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === payload.id
              ? { ...msg, status: msg.status === "read" ? "read" : "delivered" }
              : msg
          )
        );
      }
      if (type === "message.read") {
        const ids = payload.ids as string[];
        setMessages((prev) =>
          prev.map((msg) =>
            ids.includes(msg.id) ? { ...msg, status: "read" } : msg
          )
        );
      }
      if (type === "presence") {
        if (peer && payload.userId === peer.id) {
          setStatus("");
        }
      }
      if (type === "call.offer") {
        setCall((prev) => ({
          ...prev,
          status: "incoming",
          offer: payload.offer,
          isVideo: payload.isVideo,
          callerId: payload.from
        }));
        if (!peer || peer.id !== payload.from) {
          fetchPeerById(payload.from).then((userData) => {
            if (userData) {
              setPeer(userData);
            }
          });
        }
      }
      if (type === "call.answer") {
        if (call.pc && payload.answer) {
          await call.pc.setRemoteDescription(payload.answer);
          setCall((prev) => ({ ...prev, status: "in-call" }));
        }
      }
      if (type === "call.ice") {
        if (call.pc && payload.candidate) {
          await call.pc.addIceCandidate(payload.candidate);
        }
      }
      if (type === "call.end") {
        endCall();
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
    };

    return ws;
  };

  const findPeer = async () => {
    const res = await fetch(`${API_URL}/users/by-phone?phone=${peerPhone}`);
    if (!res.ok) {
      setStatus("Користувача не знайдено.");
      return;
    }
    const data = (await res.json()) as User;
    setPeer(data);
    setStatus("Контакт додано.");
    await loadMessages(data.id);
  };

  const loadMessages = async (peerId: string) => {
    if (!token || !keys) {
      return;
    }
    const res = await fetch(`${API_URL}/messages/${peerId}`, { headers: authHeaders });
    const data = await res.json();
    const mapped: UiMessage[] = [];
    for (const item of data) {
      const decrypted = await decryptIncoming(item);
      mapped.push(decrypted);
    }
    setMessages(mapped);
    const incomingIds = mapped.filter((msg) => !msg.isMine).map((msg) => msg.id);
    sendReadReceipts(peerId, incomingIds);
  };

  const fetchPeerById = async (peerId: string) => {
    const res = await fetch(`${API_URL}/users/${peerId}`);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as User;
  };

  const handleSelectChat = async (chat: {
    id: string;
    name: string;
    phone: string;
    peerPublicKey?: string;
  }) => {
    setActiveTab("chat");
    setMessages([]);
    const peerInfo = await fetchPeerById(chat.id);
    setPeer(
      peerInfo ?? {
        id: chat.id,
        phone: chat.phone,
        login: chat.name !== chat.phone ? chat.name : undefined,
        publicKey: chat.peerPublicKey
      }
    );
    await loadMessages(chat.id);
  };

  const handleSelectUser = async (userToOpen: User) => {
    setActiveTab("chat");
    setMessages([]);
    setPeer(userToOpen);
    setChatQuery("");
    setLoginMatches([]);
    await loadMessages(userToOpen.id);
  };

  const decryptIncoming = async (payload: any): Promise<UiMessage> => {
    if (!keys) {
      return {
        id: payload.id,
        from: payload.from,
        to: payload.to,
        createdAt: payload.createdAt,
        contentType: payload.contentType,
        text: "Немає ключів",
        meta: payload.meta,
        isMine: payload.from === user?.id
      };
    }
    let text: string | undefined;
    const isMine = payload.from === user?.id;
    const senderKey =
      payload.senderPublicKey ?? (isMine ? keys.publicKey : peer?.publicKey);
    if (isMine && payload.selfCiphertext && payload.selfNonce) {
      text =
        decryptMessage(payload.selfNonce, payload.selfCiphertext, keys.publicKey, keys.secretKey) ??
        "Неможливо розшифрувати";
    } else if (payload.ciphertext && payload.nonce && senderKey) {
      text =
        decryptMessage(payload.nonce, payload.ciphertext, senderKey, keys.secretKey) ??
        "Неможливо розшифрувати";
    } else if (payload.contentType === "text") {
      text = "Неможливо розшифрувати";
    }
    const status = isMine
      ? payload.readAt
        ? "read"
        : payload.deliveredAt
        ? "delivered"
        : "sent"
      : undefined;
    return {
      id: payload.id,
      from: payload.from,
      to: payload.to,
      createdAt: payload.createdAt,
      contentType: payload.contentType,
      text,
      meta: payload.meta
        ? { ...payload.meta, senderPublicKey: payload.senderPublicKey }
        : { senderPublicKey: payload.senderPublicKey },
      isMine,
      status
    };
  };

  const sendReadReceipts = (peerId: string, ids: string[]) => {
    if (!ids.length) {
      return;
    }
    const ws = initWebSocket();
    if (!ws) {
      return;
    }
    const sendPayload = () =>
      ws.send(
        JSON.stringify({
          type: "message.read",
          payload: { peerId, ids }
        })
      );
    if (ws.readyState === WebSocket.OPEN) {
      sendPayload();
    } else {
      ws.addEventListener("open", sendPayload, { once: true });
    }
  };

  const handleIncomingMessage = async (payload: any) => {
    const decrypted = await decryptIncoming(payload);
    setMessages((prev) => [...prev, decrypted]);
    if (peer && payload.from === peer.id && activeTab === "chat") {
      sendReadReceipts(peer.id, [payload.id]);
    }
  };

  const sendMessage = async (
    contentType: UiMessage["contentType"],
    text?: string,
    meta?: Record<string, string>
  ) => {
    if (!peer) {
      setStatus("Оберіть чат.");
      return;
    }
    if (!keys) {
      setStatus("Ключі не ініціалізовані.");
      return;
    }
    const ws = initWebSocket();
    if (!ws) {
      setStatus("Немає з'єднання.");
      return;
    }
    let targetKey = peer.publicKey;
    if (!targetKey) {
      const refreshed = await fetchPeerById(peer.id);
      if (refreshed?.publicKey) {
        setPeer(refreshed);
        targetKey = refreshed.publicKey;
      } else {
        setStatus("У контакта немає публічного ключа.");
        return;
      }
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const payloadText = text ?? "";
    const encrypted = encryptMessage(payloadText, keys.secretKey, targetKey ?? "");
    const selfEncrypted = encryptMessage(payloadText, keys.secretKey, keys.publicKey);
    const sendPayload = () =>
      ws.send(
        JSON.stringify({
          type: "message.send",
          payload: {
            id,
            to: peer.id,
            createdAt,
            contentType,
            nonce: encrypted.nonce,
            ciphertext: encrypted.ciphertext,
            senderPublicKey: keys.publicKey,
            selfNonce: selfEncrypted.nonce,
            selfCiphertext: selfEncrypted.ciphertext,
            meta
          }
        })
      );
    if (ws.readyState === WebSocket.OPEN) {
      sendPayload();
    } else {
      setStatus("Підключення...");
      ws.addEventListener("open", sendPayload, { once: true });
    }
    setMessages((prev) => [
      ...prev,
      {
        id,
        from: user?.id ?? "",
        to: peer.id,
        createdAt,
        contentType,
        text,
        meta,
        isMine: true,
        status: "sent"
      }
    ]);
    fetchChats();
  };

  const handleFile = async (file: File | null) => {
    if (!file || !peer || !keys) {
      return;
    }
    if (!peer.publicKey) {
      setStatus("У контакта немає публічного ключа.");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const encrypted = encryptBytes(bytes, keys.secretKey, peer.publicKey ?? "");
    const blob = new Blob([fromBase64(encrypted.ciphertext)], {
      type: "application/octet-stream"
    });
    const localUrl = URL.createObjectURL(file);
    const form = new FormData();
    form.append("file", blob, `${file.name}.enc`);
    const res = await fetch(`${API_URL}/files`, {
      method: "POST",
      headers: authHeaders,
      body: form
    });
    const data = await res.json();
    await sendMessage("file", "", {
      fileName: file.name,
      fileType: file.type,
      fileUrl: `${API_URL}${data.url}`,
      nonce: encrypted.nonce,
      localUrl
    });
  };

  const decryptFile = async (msg: UiMessage) => {
    if (!msg.meta || !keys || !peer) {
      return;
    }
    if (msg.isMine && msg.meta.localUrl) {
      window.open(msg.meta.localUrl, "_blank");
      return;
    }
    const response = await fetch(msg.meta.fileUrl);
    const buffer = new Uint8Array(await response.arrayBuffer());
    const decrypted = decryptBytes(
      msg.meta.nonce,
      toBase64(buffer),
      msg.meta.senderPublicKey ?? peer.publicKey ?? "",
      keys.secretKey
    );
    if (!decrypted) {
      setStatus("Не вдалося розшифрувати файл.");
      return;
    }
    const blob = new Blob([decrypted], { type: msg.meta.fileType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  const updateStatus = () => {
    if (!wsRef.current || !statusText) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "status.update",
        payload: { status: statusText }
      })
    );
    setStatus(`Ваш статус: ${statusText}`);
    setStatusText("");
  };

  const renderCallWindow = () => {
    const win = window.open("", "mas-call", "width=480,height=720");
    if (!win) {
      return null;
    }
    win.document.title = "MAS Call";
    win.document.body.innerHTML = `
      <style>
        body { margin: 0; background: #0c0f1a; color: #f4f6fb; font-family: Inter, system-ui, sans-serif; }
        .wrap { display: flex; flex-direction: column; height: 100vh; }
        .header { padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .label { font-weight: 600; letter-spacing: 0.04em; }
        .video { flex: 1; position: relative; display: grid; place-items: center; }
        #remoteVideo { width: 100%; height: 100%; object-fit: cover; display: none; background: #111623; }
        #localVideo { position: absolute; right: 16px; bottom: 16px; width: 140px; height: 180px; object-fit: cover; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); display: none; }
        .audio-only { color: rgba(244,246,251,0.7); font-size: 14px; }
        .controls { padding: 12px 16px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: center; }
        .end { background: #ef4444; border: none; color: #fff; padding: 10px 16px; border-radius: 12px; cursor: pointer; }
      </style>
      <div class="wrap">
        <div class="header"><div class="label" id="callLabel">Дзвінок</div></div>
        <div class="video">
          <video id="remoteVideo" autoplay playsinline></video>
          <video id="localVideo" autoplay playsinline muted></video>
          <div class="audio-only" id="audioLabel">Аудіодзвінок</div>
        </div>
        <div class="controls">
          <button class="end" id="endCallBtn">Завершити</button>
        </div>
      </div>
    `;
    const endButton = win.document.getElementById("endCallBtn");
    if (endButton) {
      endButton.addEventListener("click", () => endCall());
    }
    callWindowPartsRef.current = {
      localVideo: win.document.getElementById("localVideo") as HTMLVideoElement | null,
      remoteVideo: win.document.getElementById("remoteVideo") as HTMLVideoElement | null,
      label: win.document.getElementById("callLabel") as HTMLDivElement | null
    };
    return win;
  };

  const ensureCallWindow = (isVideo: boolean) => {
    if (!callWindowRef.current || callWindowRef.current.closed) {
      callWindowRef.current = renderCallWindow();
    }
    const parts = callWindowPartsRef.current;
    if (!parts) {
      return;
    }
    if (parts.label) {
      parts.label.textContent = isVideo ? "Відеодзвінок" : "Аудіодзвінок";
    }
    if (parts.remoteVideo) {
      parts.remoteVideo.style.display = isVideo ? "block" : "none";
    }
    if (parts.localVideo) {
      parts.localVideo.style.display = isVideo ? "block" : "none";
    }
    const audioLabel = callWindowRef.current?.document.getElementById("audioLabel");
    if (audioLabel) {
      audioLabel.textContent = isVideo ? "" : "Аудіодзвінок";
      (audioLabel as HTMLDivElement).style.display = isVideo ? "none" : "block";
    }
  };

  const syncCallWindowStreams = (localStream?: MediaStream, remoteStream?: MediaStream) => {
    const parts = callWindowPartsRef.current;
    if (!parts) {
      return;
    }
    if (parts.localVideo && localStream) {
      parts.localVideo.srcObject = localStream;
    }
    if (parts.remoteVideo && remoteStream) {
      parts.remoteVideo.srcObject = remoteStream;
    }
  };

  const closeCallWindow = () => {
    if (callWindowRef.current && !callWindowRef.current.closed) {
      callWindowRef.current.close();
    }
    callWindowRef.current = null;
    callWindowPartsRef.current = null;
  };

  const stopTone = () => {
    if (toneTimerRef.current) {
      window.clearInterval(toneTimerRef.current);
      toneTimerRef.current = null;
    }
    if (toneOscRef.current) {
      toneOscRef.current.stop();
      toneOscRef.current.disconnect();
      toneOscRef.current = null;
    }
    if (toneGainRef.current) {
      toneGainRef.current.disconnect();
      toneGainRef.current = null;
    }
  };

  const startTone = (kind: "incoming" | "outgoing") => {
    stopTone();
    if (!toneCtxRef.current) {
      toneCtxRef.current = new AudioContext();
    }
    const ctx = toneCtxRef.current;
    if (ctx.state === "suspended") {
      ctx.resume();
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = kind === "incoming" ? 520 : 440;
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    toneOscRef.current = osc;
    toneGainRef.current = gain;
    let on = false;
    toneTimerRef.current = window.setInterval(() => {
      on = !on;
      gain.gain.value = on ? 0.2 : 0;
    }, kind === "incoming" ? 600 : 900);
  };

  const createPeerConnection = () =>
    new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

  const startCall = async (isVideo = false) => {
    if (!peer) {
      return;
    }
    const ws = initWebSocket();
    if (!ws) {
      setStatus("Немає з'єднання.");
      return;
    }
    const pc = createPeerConnection();
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(
          JSON.stringify({
            type: "call.ice",
            payload: { to: peer.id, candidate: event.candidate }
          })
        );
      }
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
      }
      setCall((prev) => ({ ...prev, remoteStream: stream }));
    };
    const localStream = await navigator.mediaDevices.getUserMedia(
      isVideo ? { audio: true, video: true } : { audio: true }
    );
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(
      JSON.stringify({
        type: "call.offer",
        payload: { to: peer.id, offer, isVideo }
      })
    );
    setCall({ status: "calling", pc, localStream, isVideo });
  };

  const acceptCall = async () => {
    if (!call.offer) {
      return;
    }
    stopTone();
    let currentPeer = peer;
    if (!currentPeer && call.callerId) {
      const fetched = await fetchPeerById(call.callerId);
      if (fetched) {
        setPeer(fetched);
        currentPeer = fetched;
      }
    }
    if (!currentPeer) {
      setStatus("Немає даних співрозмовника.");
      return;
    }
    const ws = initWebSocket();
    if (!ws) {
      setStatus("Немає з'єднання.");
      return;
    }
    const pc = createPeerConnection();
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(
          JSON.stringify({
            type: "call.ice",
            payload: { to: currentPeer.id, candidate: event.candidate }
          })
        );
      }
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
      }
      setCall((prev) => ({ ...prev, remoteStream: stream }));
    };
    const localStream = await navigator.mediaDevices.getUserMedia(
      call.isVideo ? { audio: true, video: true } : { audio: true }
    );
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    await pc.setRemoteDescription(call.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(
      JSON.stringify({
        type: "call.answer",
        payload: { to: currentPeer.id, answer }
      })
    );
    setCall({ status: "in-call", pc, localStream, isVideo: call.isVideo });
  };

  const endCall = () => {
    call.pc?.close();
    call.localStream?.getTracks().forEach((track) => track.stop());
    stopTone();
    const targetId = peer?.id ?? call.callerId;
    if (targetId) {
      wsRef.current?.send(
        JSON.stringify({
          type: "call.end",
          payload: { to: targetId }
        })
      );
    }
    closeCallWindow();
    setCall({ status: "idle" });
  };

  useEffect(() => {
    if (call.status === "calling" || call.status === "in-call") {
      ensureCallWindow(Boolean(call.isVideo));
      syncCallWindowStreams(call.localStream, call.remoteStream);
      return;
    }
    if (call.status === "idle") {
      closeCallWindow();
    }
  }, [call.status, call.isVideo, call.localStream, call.remoteStream]);

  useEffect(() => {
    if (call.status === "incoming") {
      startTone("incoming");
      return;
    }
    if (call.status === "calling") {
      startTone("outgoing");
      return;
    }
    stopTone();
  }, [call.status]);

  if (!isAuthed) {
    return (
      <div className="auth">
        <h1>MAS Secure</h1>
        <p>Вхід за номером телефону (SMS).</p>
        <div className="phone-row">
          <div className="select-wrapper" ref={selectRef}>
            <button
              type="button"
              className="select-trigger"
              onClick={() => setCountryOpen((prev) => !prev)}
            >
              <span>
                {activeCountry?.name ?? country} (+{activeCountry?.dial ?? dialCode})
              </span>
              <span className="chevron" />
            </button>
            {countryOpen && (
              <div className="select-panel">
                <input
                  className="select-search"
                  placeholder="Пошук країни або коду"
                  value={countryQuery}
                  onChange={(event) => setCountryQuery(event.target.value)}
                />
                <div className="select-list">
                  {filteredCountries.map((item) => (
                    <button
                      type="button"
                      key={item.code}
                      className={`select-item ${item.code === country ? "active" : ""}`}
                      onClick={() => {
                        setCountry(item.code);
                        setCountryOpen(false);
                      }}
                    >
                      <span>{item.name}</span>
                      <span className="dial">+{item.dial}</span>
                    </button>
                  ))}
                  {filteredCountries.length === 0 && (
                    <div className="select-empty">Нічого не знайдено</div>
                  )}
                </div>
              </div>
            )}
          </div>
          <input
            placeholder="Номер"
            value={localNumber}
            onChange={(event) => setLocalNumber(event.target.value)}
          />
        </div>
        <span className="hint">Повний номер: {fullPhone}</span>
        <button onClick={requestCode}>Отримати код</button>
        {devCode && <span className="hint">Dev-код: {devCode}</span>}
        <input
          placeholder="Код"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button onClick={verifyCode}>Увійти</button>
        {status && <div className="status">{status}</div>}
      </div>
    );
  }

  return (
    <div className={`app ${isMenuOpen ? "menu-open" : "menu-closed"}`}>
      <aside className="sidebar">
        <div className="profile">
          <div>
            <div className="profile-row">
              <div className="profile-left">
                <div className="logo">MAS</div>
              </div>
            </div>
            <div className="sidebar-search">
              <input
                placeholder="Пошук чатів"
                value={chatQuery}
                onChange={(event) => setChatQuery(event.target.value)}
              />
            </div>
            {chatQuery.trim().length >= 3 && (
              <div className="chat-people">
                <div className="chat-people-title">Люди</div>
                {loginMatches.length === 0 ? (
                  <div className="chat-empty">Нічого не знайдено</div>
                ) : (
                  loginMatches.map((item) => (
                    <button
                      key={item.id}
                      className="chat-item"
                      onClick={() => handleSelectUser(item)}
                    >
                      <div className="chat-avatar">
                        {(item.login ?? item.phone).slice(0, 1).toUpperCase()}
                      </div>
                      <div className="chat-meta">
                        <div className="chat-row">
                          <span className="chat-name">{item.login ?? item.phone}</span>
                          <span className="chat-time">@{item.login}</span>
                        </div>
                        <span className="chat-preview">{item.phone}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
            <div className="chat-list">
              {chatItems.length === 0 ? (
                <div className="chat-empty">Чатів не знайдено</div>
              ) : (
                chatItems.map((chat) => (
                  <button
                    key={chat.id}
                    className={`chat-item ${peer?.id === chat.id ? "active" : ""}`}
                    onClick={() => handleSelectChat(chat)}
                  >
                    <div className="chat-avatar">
                      {chat.name.slice(0, 1).toUpperCase()}
                      {chat.online && <span className="chat-dot" />}
                    </div>
                    <div className="chat-meta">
                      <div className="chat-row">
                        <span className="chat-name">{chat.name}</span>
                        <span className="chat-time">{chat.time}</span>
                      </div>
                      <span className="chat-preview">{chat.lastMessage}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
        <div className="status">{status}</div>
        {call.status === "incoming" && activeTab === "chat" && (
          <div className="call-card">
            <p>{call.isVideo ? "Вхідний відеодзвінок" : "Вхідний дзвінок"}</p>
            <button onClick={acceptCall}>Прийняти</button>
            <button onClick={endCall}>Відхилити</button>
          </div>
        )}
        {call.status === "in-call" && activeTab === "chat" && (
          <div className="call-card">
            <p>Дзвінок активний</p>
            <button onClick={endCall}>Завершити</button>
          </div>
        )}
        <audio ref={remoteAudioRef} autoPlay />
      </aside>
      <div className="backdrop" onClick={() => setIsMenuOpen(false)} />
      <div className="content">
        <div className="topbar">
          <div className="topbar-left">
            <button className="hamburger" onClick={() => setIsMenuOpen((prev) => !prev)}>
              <span />
              <span />
              <span />
            </button>
            <button
              className="gear"
              onClick={() =>
                setActiveTab((prev) => (prev === "settings" ? "chat" : "settings"))
              }
              aria-label="Налаштування"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19.14 12.94a7.84 7.84 0 0 0 .05-.94 7.84 7.84 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.22-1.12.52-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.03.31-.05.63-.05.94s.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.51.41 1.05.72 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.22 1.12-.52 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"/>
              </svg>
            </button>
          </div>
          <div className="topbar-title">
            {activeTab === "chat" ? (peer ? peer.login ?? peer.phone : "") : "Налаштування"}
          </div>
          {activeTab === "chat" && peer && (
            <div className="call-actions">
              <button className="video-btn" onClick={() => startCall(true)} aria-label="Відеодзвінок">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h10zm7.5 2.5-3.5 2v-3l3.5 2z"/>
                </svg>
              </button>
              <button className="phone-btn" onClick={() => startCall(false)} aria-label="Дзвінок">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.56.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 6a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.56 1 1 0 0 1-.24 1.02z"/>
                </svg>
              </button>
            </div>
          )}
        </div>
        <main className="chat">
        {activeTab === "chat" ? (
          peer ? (
            <>
              <div className="messages">
                {messages.map((msg) => (
                  <div className={`message ${msg.isMine ? "out" : "in"}`} key={msg.id}>
                    {msg.contentType === "file" && msg.meta ? (
                      <button onClick={() => decryptFile(msg)}>
                        Файл: {msg.meta.fileName} (розшифрувати)
                      </button>
                    ) : msg.contentType === "gif" && msg.meta ? (
                      <img src={msg.meta.url} alt="gif" />
                    ) : msg.contentType === "sticker" && msg.meta ? (
                      <div className="sticker">{msg.meta.label}</div>
                    ) : (
                      <span>{msg.text}</span>
                    )}
                    <div className="message-meta">
                      <span className="message-time">{formatTime(msg.createdAt)}</span>
                      {msg.isMine && (
                        <span className={`message-status ${msg.status ?? "sent"}`}>
                          {msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : "✓"}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="composer">
                <div className="composer-row">
                  <input
                    placeholder="Повідомлення"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        const target = event.target as HTMLInputElement;
                        const value = target.value.trim();
                        if (value) {
                          sendMessage("text", value);
                          target.value = "";
                        }
                      }
                    }}
                  />
                  <label className="attach-btn" aria-label="Завантажити файл">
                    <input
                      type="file"
                      onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
                    />
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M16.5 6.5 8.5 14.5a2.5 2.5 0 0 0 3.54 3.54l8.25-8.25a4 4 0 0 0-5.66-5.66l-8.6 8.6a5.5 5.5 0 0 0 7.78 7.78l8.07-8.07"/>
                    </svg>
                  </label>
                </div>
              </div>
            </>
          ) : null
        ) : (
          <div className="settings">
            <h2>Налаштування</h2>
            <div className="settings-grid">
              <section className="settings-section">
                <h3>Програма</h3>
                <label className="settings-row">
                  <span>Сповіщення</span>
                  <input
                    className="toggle"
                    type="checkbox"
                    checked={notificationsEnabled}
                    onChange={(event) => setNotificationsEnabled(event.target.checked)}
                  />
                </label>
                <label className="settings-row">
                  <span>Запускати при старті системи</span>
                  <input
                    className="toggle"
                    type="checkbox"
                    checked={startOnBoot}
                    onChange={(event) => setStartOnBoot(event.target.checked)}
                  />
                </label>
              </section>

              <section className="settings-section">
                <h3>Акаунт</h3>
                <label className="settings-row column">
                  <span>Ім'я користувача</span>
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
                <label className="settings-row column">
                  <span>Логін</span>
                  <input
                    value={loginValue}
                    onChange={(event) => setLoginValue(event.target.value)}
                    placeholder="наприклад: mas_user"
                  />
                </label>
                <div className="settings-row">
                  <span>Унікальний логін</span>
                  <button className="ghost" onClick={saveLogin}>Зберегти</button>
                </div>
                <div className="settings-row">
                  <span>Номер телефону</span>
                  <span className="muted">{user?.phone}</span>
                </div>
                <div className="settings-row">
                  <span>Сеанс</span>
                  <button className="ghost" onClick={logout}>Вийти</button>
                </div>
              </section>

              <section className="settings-section">
                <h3>Пошук користувачів</h3>
                <div className="muted">
                  Пошук виконується через поле “Пошук чатів” у лівому меню.
                </div>
              </section>

              <section className="settings-section">
                <h3>Конфіденційність</h3>
                <label className="settings-row">
                  <span>Звіти про прочитання</span>
                  <input
                    className="toggle"
                    type="checkbox"
                    checked={readReceipts}
                    onChange={(event) => setReadReceipts(event.target.checked)}
                  />
                </label>
                <label className="settings-row">
                  <span>Індикатор набору</span>
                  <input
                    className="toggle"
                    type="checkbox"
                    checked={typingIndicator}
                    onChange={(event) => setTypingIndicator(event.target.checked)}
                  />
                </label>
                <label className="settings-row">
                  <span>Останній онлайн</span>
                  <input
                    className="toggle"
                    type="checkbox"
                    checked={lastSeenVisible}
                    onChange={(event) => setLastSeenVisible(event.target.checked)}
                  />
                </label>
              </section>

              <section className="settings-section">
                <h3>Пристрої</h3>
                <div className="device-list">
                  {devices.map((device) => (
                    <div key={device.name} className="device-card">
                      <div>
                        <div className="device-name">{device.name}</div>
                        <div className="muted">{device.location}</div>
                      </div>
                      <span className="status-pill">{device.lastActive}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="settings-section">
                <h3>Історія дій</h3>
                <div className="activity-list">
                  {activityLog.map((item) => (
                    <div className="activity-row" key={item.title}>
                      <span>{item.title}</span>
                      <span className="muted">{item.time}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}

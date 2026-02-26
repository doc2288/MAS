import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  contentType: "text" | "file" | "emoji" | "sticker" | "gif" | "voice";
  text?: string;
  meta?: Record<string, string>;
  isMine: boolean;
  status?: "sent" | "delivered" | "read";
  replyToId?: string;
  editedAt?: string;
  pinned?: boolean;
  reactions?: Record<string, string[]>;
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
const emojiCategories: Record<string, string[]> = {
  "Обличчя": ["😀","😂","🤣","😍","🥰","😘","😎","🤩","🥳","😏","🤔","🙄","😴","🤯","🥺","😤","😭","😱","🤗","😇"],
  "Жести": ["👍","👎","👋","🤝","🙏","💪","✌️","🤟","👏","🫶","☝️","👆","👇","👉","👈","✋","🤚","🖖","🫡","🫰"],
  "Серця": ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","❤️‍🔥","💕","💖","💗","💘","💝","♥️","🫀","💟","❣️","💞"],
  "Об'єкти": ["🔥","⭐","✨","💫","🌟","🎉","🎊","🎁","🏆","🥇","💎","🔑","💡","📌","📎","✏️","📝","💬","🔒","🚀"],
  "Символи": ["✅","❌","⚠️","💯","♻️","🔄","➡️","⬅️","⬆️","⬇️","▶️","⏸️","🔴","🟢","🔵","⚪","⚫","🟡","🟣","🟠"]
};
const allEmojis = Object.values(emojiCategories).flat();

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const formatDate = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Сьогодні";
  if (d.toDateString() === yesterday.toDateString()) return "Вчора";
  return d.toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" });
};

const notifSound = (() => {
  let ctx: AudioContext | null = null;
  return () => {
    try {
      if (!ctx) ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 800;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.stop(ctx.currentTime + 0.15);
    } catch { /* ignore */ }
  };
})();

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
  const [peer, setPeer] = useState<User | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [status, setStatus] = useState("");
  
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
  const [peerTyping, setPeerTyping] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [showEmoji, setShowEmoji] = useState(false);
  const [msgInput, setMsgInput] = useState("");
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});
  const [replyTo, setReplyTo] = useState<UiMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<UiMessage | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; msg: UiMessage } | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [reactionPicker, setReactionPicker] = useState<string | null>(null);
  const [emojiCategory, setEmojiCategory] = useState("Обличчя");
  const [emojiSearch, setEmojiSearch] = useState("");
  const quickReactions = ["👍","❤️","😂","😮","😢","🔥","🚀"];

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const callWindowRef = useRef<Window | null>(null);
  const callWindowPartsRef = useRef<{
    localVideo?: HTMLVideoElement;
    remoteVideo?: HTMLVideoElement;
    label?: HTMLDivElement;
    peerName?: HTMLDivElement;
    statusLabel?: HTMLDivElement;
    timerLabel?: HTMLDivElement;
    avatar?: HTMLDivElement;
    micBtn?: HTMLButtonElement;
    camBtn?: HTMLButtonElement;
    fullscreenBtn?: HTMLButtonElement;
    timerInterval?: number;
    timerStartTime?: number;
  } | null>(null);
  const toneCtxRef = useRef<AudioContext | null>(null);
  const toneOscRef = useRef<OscillatorNode | null>(null);
  const toneGainRef = useRef<GainNode | null>(null);
  const toneTimerRef = useRef<number | null>(null);
  const selectRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const peerTypingTimerRef = useRef<number | null>(null);
  const peerRef = useRef<User | null>(null);
  const callRef = useRef<CallState>({ status: "idle" });
  const screenShareRef = useRef<{ stream: MediaStream; originalTrack: MediaStreamTrack | null; sender: RTCRtpSender | null } | null>(null);

  const devices = [
    { name: "MAS Desktop", location: "Windows · Локально", lastActive: "Активний зараз" },
    { name: "MAS Web", location: "Chrome · Київ", lastActive: "2 хв тому" }
  ];
  const activityLog = [
    { title: "Вхід у акаунт", time: "Сьогодні, 09:12" },
    { title: "Зміна статусу", time: "Сьогодні, 09:05" },
    { title: "Надіслано файл", time: "Вчора, 21:40" }
  ];

  useEffect(() => { peerRef.current = peer; }, [peer]);
  useEffect(() => { callRef.current = call; }, [call]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  const chatItems = useMemo(() => {
    const labelForType = (type: UiMessage["contentType"]) => {
      switch (type) {
        case "file": return "Файл";
        case "gif": return "GIF";
        case "sticker": return "Стікер";
        case "emoji": return "Емодзі";
        default: return "Зашифроване повідомлення";
      }
    };
    const items = chatList.map((item) => ({
      id: item.peerId,
      name: item.peerLogin ?? item.peerPhone,
      phone: item.peerPhone,
      lastMessage: labelForType(item.lastContentType),
      time: new Date(item.lastMessageAt).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit"
      }),
      online: onlineUserIds.has(item.peerId),
      peerPublicKey: item.peerPublicKey,
      unread: unreadMap[item.peerId] ?? 0
    }));
    if (!chatQuery.trim()) return items;
    const q = chatQuery.toLowerCase().trim();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.phone.toLowerCase().includes(q) ||
        item.lastMessage.toLowerCase().includes(q)
    );
  }, [chatList, chatQuery, onlineUserIds, unreadMap]);

  const countryOptions = useMemo(() => {
    const makeDisplay = (locale: string) => {
      try { return new Intl.DisplayNames([locale], { type: "region" }); } catch { return null; }
    };
    const displayDefault = makeDisplay(navigator.language);
    const displayRu = makeDisplay("ru");
    const displayUk = makeDisplay("uk");
    const displayEn = makeDisplay("en");
    return getCountries()
      .map((item) => {
        const names = [
          displayDefault?.of(item), displayRu?.of(item), displayUk?.of(item), displayEn?.of(item)
        ].filter(Boolean) as string[];
        const name = names[0] ?? item;
        return {
          code: item, name, dial: getCountryCallingCode(item),
          search: `${names.join(" ")} ${item}`.toLowerCase()
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const translitToLatin = (value: string) => {
    const map: Record<string, string> = {
      а:"a",б:"b",в:"v",г:"g",ґ:"g",д:"d",е:"e",ё:"yo",є:"ye",ж:"zh",з:"z",и:"i",і:"i",ї:"yi",
      й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",
      ч:"ch",ш:"sh",щ:"shch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya"
    };
    return value.split("").map((c) => map[c] ?? c).join("");
  };

  const filteredCountries = useMemo(() => {
    if (!countryQuery.trim()) return countryOptions;
    const normalize = (v: string) => v.toLowerCase().replace(/[().\-\s]/g, "").trim();
    const q = normalize(countryQuery);
    const qLatin = normalize(translitToLatin(q));
    const qDigits = q.replace(/\D/g, "");
    return countryOptions.filter((item) => {
      const name = normalize(item.name);
      const nameLatin = normalize(translitToLatin(name));
      const search = normalize(item.search);
      const searchLatin = normalize(translitToLatin(search));
      const cd = normalize(item.code);
      const dial = normalize(item.dial);
      return (
        name.includes(q) || nameLatin.includes(q) || name.includes(qLatin) ||
        nameLatin.includes(qLatin) || search.includes(q) || searchLatin.includes(q) ||
        search.includes(qLatin) || searchLatin.includes(qLatin) || cd.includes(q) ||
        (qDigits.length > 0 && dial.includes(qDigits))
      );
    });
  }, [countryOptions, countryQuery]);

  const activeCountry = useMemo(() => countryOptions.find((i) => i.code === country), [countryOptions, country]);
  const dialCode = useMemo(() => getCountryCallingCode(country as any), [country]);
  const fullPhone = useMemo(() => `+${dialCode}${localNumber.replace(/\D/g, "")}`, [dialCode, localNumber]);

  const isAuthed = Boolean(token);
  const authHeaders = useMemo(
    (): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {},
    [token]
  );

  const fetchChats = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_URL}/chats`, { headers: authHeaders });
      if (!res.ok) return;
      const data = (await res.json()) as ChatSummary[];
      setChatList(data);
    } catch { /* offline */ }
  }, [token, authHeaders]);

  const saveLogin = async () => {
    if (!loginValue.trim()) { setStatus("Вкажіть логін."); return; }
    try {
      const res = await fetch(`${API_URL}/users/login`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ login: loginValue })
      });
      if (res.status === 409) { setStatus("Логін уже зайнятий."); return; }
      if (!res.ok) { setStatus("Не вдалося зберегти логін."); return; }
      const data = await res.json();
      setUser((prev) => (prev ? { ...prev, login: data.login } : prev));
      setStatus("Логін оновлено.");
    } catch { setStatus("Помилка мережі."); }
  };

  const findUserByLogin = useCallback(async () => {
    if (!chatQuery.trim() || chatQuery.trim().length < 3) { setLoginMatches([]); return; }
    try {
      const res = await fetch(
        `${API_URL}/users/search?query=${encodeURIComponent(chatQuery.trim())}`,
        { headers: authHeaders }
      );
      if (!res.ok) { setLoginMatches([]); return; }
      const data = (await res.json()) as User[];
      setLoginMatches(data);
    } catch { setLoginMatches([]); }
  }, [chatQuery, authHeaders]);

  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}/users/me`, { headers: authHeaders })
      .then((res) => {
        if (res.status === 401) {
          localStorage.removeItem("mas.token");
          setToken(null);
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        setUser(data);
        if (data?.login) setLoginValue(data.login);
      })
      .catch(() => {});
  }, [token, authHeaders]);

  useEffect(() => { fetchChats(); }, [fetchChats]);

  useEffect(() => {
    if (!token) return;
    if (keys) {
      fetch(`${API_URL}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ publicKey: keys.publicKey, secretKey: keys.secretKey })
      }).catch(() => {});
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${API_URL}/keys/pair`, { headers: authHeaders });
        if (res.ok) {
          const saved = await res.json();
          if (saved.publicKey && saved.secretKey) {
            const restored = { publicKey: saved.publicKey, secretKey: saved.secretKey };
            localStorage.setItem("mas.keys", JSON.stringify(restored));
            setKeys(restored);
            return;
          }
        }
      } catch { /* ignore */ }
      const pair = generateKeyPair();
      localStorage.setItem("mas.keys", JSON.stringify(pair));
      setKeys(pair);
    })();
  }, [token, keys, authHeaders]);

  // WebSocket with auto-reconnect
  const connectWebSocket = useCallback(() => {
    if (!token) return;
    if (wsRef.current) {
      const s = wsRef.current.readyState;
      if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
    }

    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("");
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    };

    ws.onmessage = async (event) => {
      const { type, payload } = JSON.parse(event.data);
      if (type === "message.receive") {
        await handleIncomingMessage(payload);
        fetchChats();
        if (notificationsEnabled) notifSound();
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
          prev.map((msg) => ids.includes(msg.id) ? { ...msg, status: "read" } : msg)
        );
      }
      if (type === "message.deleted") {
        setMessages((prev) => prev.filter((msg) => msg.id !== payload.id));
      }
      if (type === "message.edited") {
        decryptIncoming(payload).then((decrypted) => {
          setMessages((prev) => prev.map((msg) =>
            msg.id === payload.id ? { ...decrypted, editedAt: payload.editedAt } : msg
          ));
        });
      }
      if (type === "message.pinned") {
        setMessages((prev) => prev.map((msg) =>
          msg.id === payload.id ? { ...msg, pinned: payload.pinned } : msg
        ));
      }
      if (type === "message.reacted") {
        setMessages((prev) => prev.map((msg) =>
          msg.id === payload.id ? { ...msg, reactions: payload.reactions } : msg
        ));
      }
      if (type === "presence") {
        setOnlineUserIds((prev) => {
          const next = new Set(prev);
          if (payload.isOnline) next.add(payload.userId);
          else next.delete(payload.userId);
          return next;
        });
        if (payload.isOnline && peerRef.current && peerRef.current.id === payload.userId && !peerRef.current.publicKey) {
          fetchPeerById(payload.userId).then((u) => { if (u?.publicKey) setPeer(u); });
        }
      }
      if (type === "typing") {
        if (payload.from === peerRef.current?.id) {
          setPeerTyping(true);
          if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
          peerTypingTimerRef.current = window.setTimeout(() => setPeerTyping(false), 3000);
        }
      }
      if (type === "call.offer") {
        if (payload.renegotiate && callRef.current.pc && callRef.current.status === "in-call") {
          const pc = callRef.current.pc;
          await pc.setRemoteDescription(payload.offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "call.answer", payload: { to: payload.from, answer }
            }));
          }
        } else {
          setCall((prev) => ({
            ...prev, status: "incoming", offer: payload.offer,
            isVideo: payload.isVideo, callerId: payload.from
          }));
          if (!peerRef.current || peerRef.current.id !== payload.from) {
            fetchPeerById(payload.from).then((u) => { if (u) setPeer(u); });
          }
        }
      }
      if (type === "call.answer") {
        if (callRef.current.pc && payload.answer) {
          await callRef.current.pc.setRemoteDescription(payload.answer);
          setCall((prev) => ({ ...prev, status: "in-call" }));
        }
      }
      if (type === "call.ice") {
        if (callRef.current.pc && payload.candidate) {
          await callRef.current.pc.addIceCandidate(payload.candidate);
        }
      }
      if (type === "call.end") { endCall(); }
    };

    ws.onclose = () => {
      wsRef.current = null;
      reconnectTimer.current = window.setTimeout(() => connectWebSocket(), 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [token, fetchChats, notificationsEnabled]);

  useEffect(() => {
    if (!token) return;
    connectWebSocket();
    return () => {
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    };
  }, [token, connectWebSocket]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(event.target as Node))
        setCountryOpen(false);
    };
    if (countryOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [countryOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => findUserByLogin(), 300);
    return () => window.clearTimeout(timer);
  }, [findUserByLogin]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(""), 10000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [ctxMenu]);

  const filteredMessages = useMemo(() => {
    if (!chatSearch.trim()) return messages;
    const q = chatSearch.toLowerCase();
    return messages.filter((m) => m.text?.toLowerCase().includes(q));
  }, [messages, chatSearch]);

  const requestCode = async () => {
    if (!isValidPhoneNumber(fullPhone)) { setStatus("Невірний номер телефону."); return; }
    try {
      const res = await fetch(`${API_URL}/auth/request`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fullPhone })
      });
      const data = await res.json();
      setDevCode(data.devCode ?? "");
      setStatus("Код надіслано (dev).");
    } catch { setStatus("Помилка мережі."); }
  };

  const verifyCode = async () => {
    if (!isValidPhoneNumber(fullPhone)) { setStatus("Невірний номер телефону."); return; }
    try {
      const res = await fetch(`${API_URL}/auth/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fullPhone, code })
      });
      const data = await res.json();
      if (data.token) {
        setToken(data.token); localStorage.setItem("mas.token", data.token);
        setUser(data.user); setStatus("Авторизація успішна.");
      } else { setStatus("Код невірний."); }
    } catch { setStatus("Помилка мережі."); }
  };

  const logout = () => {
    setToken(null); setUser(null); setPeer(null); setMessages([]);
    localStorage.removeItem("mas.token");
    wsRef.current?.close();
  };

  const findPeer = async (phone: string) => {
    try {
      const res = await fetch(`${API_URL}/users/by-phone?phone=${phone}`);
      if (!res.ok) { setStatus("Користувача не знайдено."); return; }
      const data = (await res.json()) as User;
      setPeer(data); setStatus("Контакт додано.");
      await loadMessages(data.id);
    } catch { setStatus("Помилка мережі."); }
  };

  const loadMessages = async (peerId: string, append = false) => {
    if (!token || !keys) return;
    try {
      const offset = append ? messages.length : 0;
      const res = await fetch(`${API_URL}/messages/${peerId}?limit=100&offset=${offset}`, { headers: authHeaders });
      const data = await res.json();
      const mapped: UiMessage[] = [];
      for (const item of data) { mapped.push(await decryptIncoming(item)); }
      if (append) { setMessages((prev) => [...mapped, ...prev]); }
      else { setMessages(mapped); }
      const incomingIds = mapped.filter((msg) => !msg.isMine).map((msg) => msg.id);
      sendReadReceipts(peerId, incomingIds);
      setUnreadMap((prev) => ({ ...prev, [peerId]: 0 }));
    } catch { /* offline */ }
  };

  const fetchPeerById = async (peerId: string) => {
    try {
      const res = await fetch(`${API_URL}/users/${peerId}`);
      if (!res.ok) return null;
      return (await res.json()) as User;
    } catch { return null; }
  };

  const handleSelectChat = async (chat: {
    id: string; name: string; phone: string; peerPublicKey?: string;
  }) => {
    setActiveTab("chat"); setMessages([]);
    const peerInfo = await fetchPeerById(chat.id);
    setPeer(peerInfo ?? {
      id: chat.id, phone: chat.phone,
      login: chat.name !== chat.phone ? chat.name : undefined,
      publicKey: chat.peerPublicKey
    });
    await loadMessages(chat.id);
  };

  const handleSelectUser = async (userToOpen: User) => {
    setActiveTab("chat"); setMessages([]);
    setPeer(userToOpen); setChatQuery(""); setLoginMatches([]);
    await loadMessages(userToOpen.id);
  };

  const tryDecrypt = (nonce: string, ct: string, pubKey: string, secKey: string): string | undefined => {
    try { return decryptMessage(nonce, ct, pubKey, secKey) ?? undefined; } catch { return undefined; }
  };

  const decryptIncoming = async (payload: any): Promise<UiMessage> => {
    const isMine = payload.from === user?.id;
    if (!keys) {
      return {
        id: payload.id, from: payload.from, to: payload.to,
        createdAt: payload.createdAt, contentType: payload.contentType,
        text: "🔒 Немає ключів шифрування", meta: { ...payload.meta, decryptFailed: "true" },
        isMine
      };
    }
    let text: string | undefined;
    let decryptFailed = false;

    // Try self-encrypted copy first (works for own messages regardless of peer key changes)
    if (payload.selfCiphertext && payload.selfNonce) {
      text = tryDecrypt(payload.selfNonce, payload.selfCiphertext, keys.publicKey, keys.secretKey);
    }

    // Try peer-encrypted copy with senderPublicKey
    if (!text && payload.ciphertext && payload.nonce && payload.senderPublicKey) {
      text = tryDecrypt(payload.nonce, payload.ciphertext, payload.senderPublicKey, keys.secretKey);
    }

    // Try peer-encrypted copy with peer's current publicKey
    if (!text && payload.ciphertext && payload.nonce && peer?.publicKey) {
      text = tryDecrypt(payload.nonce, payload.ciphertext, peer.publicKey, keys.secretKey);
    }

    // Try peer-encrypted copy with own publicKey (in case the message was to ourselves)
    if (!text && payload.ciphertext && payload.nonce) {
      text = tryDecrypt(payload.nonce, payload.ciphertext, keys.publicKey, keys.secretKey);
    }

    if (!text && payload.contentType === "text") {
      text = "🔒 Повідомлення зашифроване іншим ключем";
      decryptFailed = true;
    }

    const msgStatus = isMine
      ? payload.readAt ? "read" : payload.deliveredAt ? "delivered" : "sent"
      : undefined;
    return {
      id: payload.id, from: payload.from, to: payload.to,
      createdAt: payload.createdAt, contentType: payload.contentType,
      text, meta: payload.meta
        ? { ...payload.meta, senderPublicKey: payload.senderPublicKey, ...(decryptFailed ? { decryptFailed: "true" } : {}) }
        : { senderPublicKey: payload.senderPublicKey, ...(decryptFailed ? { decryptFailed: "true" } : {}) },
      isMine, status: msgStatus as UiMessage["status"],
      replyToId: payload.replyToId,
      editedAt: payload.editedAt,
      pinned: payload.pinned,
      reactions: payload.reactions
    };
  };

  const sendReadReceipts = (peerId: string, ids: string[]) => {
    if (!ids.length || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "message.read", payload: { peerId, ids } }));
  };

  const handleIncomingMessage = async (payload: any) => {
    const decrypted = await decryptIncoming(payload);
    setMessages((prev) => [...prev, decrypted]);
    if (peer && payload.from === peer.id && activeTab === "chat") {
      sendReadReceipts(peer.id, [payload.id]);
    } else {
      setUnreadMap((prev) => ({
        ...prev,
        [payload.from]: (prev[payload.from] ?? 0) + 1
      }));
    }
  };

  const sendTyping = () => {
    if (!peer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (typingTimerRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "typing", payload: { to: peer.id } }));
    typingTimerRef.current = window.setTimeout(() => { typingTimerRef.current = null; }, 2000);
  };

  const sendMessage = async (
    contentType: UiMessage["contentType"],
    text?: string,
    meta?: Record<string, string>,
    replyToId?: string
  ) => {
    if (!peer) { setStatus("Оберіть чат."); return; }
    if (!keys) { setStatus("Ключі не ініціалізовані."); return; }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatus("Немає з'єднання."); return;
    }
    let targetKey = peer.publicKey;
    if (!targetKey) {
      const refreshed = await fetchPeerById(peer.id);
      if (refreshed?.publicKey) { setPeer(refreshed); targetKey = refreshed.publicKey; }
      else { setStatus("Контакт ще не увійшов у месенджер. Публічний ключ з'явиться після першого входу."); return; }
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const payloadText = text ?? "";
    const encrypted = encryptMessage(payloadText, keys.secretKey, targetKey);
    const selfEncrypted = encryptMessage(payloadText, keys.secretKey, keys.publicKey);
    wsRef.current.send(JSON.stringify({
      type: "message.send",
      payload: {
        id, to: peer.id, createdAt, contentType,
        nonce: encrypted.nonce, ciphertext: encrypted.ciphertext,
        senderPublicKey: keys.publicKey,
        selfNonce: selfEncrypted.nonce, selfCiphertext: selfEncrypted.ciphertext,
        meta,
        ...(replyToId ? { replyToId } : {})
      }
    }));
    setMessages((prev) => [
      ...prev,
      { id, from: user?.id ?? "", to: peer.id, createdAt, contentType, text, meta, isMine: true, status: "sent", replyToId }
    ]);
    fetchChats();
  };

  const handleSendText = () => {
    const value = msgInput.trim();
    if (!value) return;
    if (editingMsg) {
      editMessage(editingMsg.id, value);
      setMsgInput("");
      return;
    }
    sendMessage("text", value, undefined, replyTo?.id);
    setMsgInput("");
    setShowEmoji(false);
    setReplyTo(null);
  };

  const editMessage = async (msgId: string, newText: string) => {
    if (!peer || !keys || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    let targetKey = peer.publicKey;
    if (!targetKey) return;
    const encrypted = encryptMessage(newText, keys.secretKey, targetKey);
    const selfEncrypted = encryptMessage(newText, keys.secretKey, keys.publicKey);
    wsRef.current.send(JSON.stringify({
      type: "message.edit",
      payload: {
        id: msgId, peerId: peer.id,
        nonce: encrypted.nonce, ciphertext: encrypted.ciphertext,
        selfNonce: selfEncrypted.nonce, selfCiphertext: selfEncrypted.ciphertext,
        senderPublicKey: keys.publicKey
      }
    }));
    setMessages((prev) => prev.map((m) =>
      m.id === msgId ? { ...m, text: newText, editedAt: new Date().toISOString() } : m
    ));
    setEditingMsg(null);
  };

  const pinMessage = (msgId: string) => {
    if (!peer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "message.pin", payload: { id: msgId, peerId: peer.id } }));
    setMessages((prev) => prev.map((m) =>
      m.id === msgId ? { ...m, pinned: !m.pinned } : m
    ));
  };

  const reactToMessage = (msgId: string, emoji: string) => {
    if (!peer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "message.react", payload: { id: msgId, peerId: peer.id, emoji } }));
    setMessages((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      const reactions = { ...(m.reactions ?? {}) };
      if (!reactions[emoji]) reactions[emoji] = [];
      const uid = user?.id ?? "";
      const idx = reactions[emoji].indexOf(uid);
      if (idx >= 0) { reactions[emoji].splice(idx, 1); if (!reactions[emoji].length) delete reactions[emoji]; }
      else { reactions[emoji] = [uid]; }
      return { ...m, reactions };
    }));
    setReactionPicker(null);
  };

  const copyMessageText = (text: string) => {
    navigator.clipboard.writeText(text).then(() => setStatus("Скопійовано")).catch(() => {});
  };

  const startReply = (msg: UiMessage) => { setReplyTo(msg); setEditingMsg(null); setCtxMenu(null); };
  const startEdit = (msg: UiMessage) => { setEditingMsg(msg); setMsgInput(msg.text ?? ""); setReplyTo(null); setCtxMenu(null); };
  const cancelReplyEdit = () => { setReplyTo(null); setEditingMsg(null); setMsgInput(""); };

  const deleteMessage = (msgId: string) => {
    if (!peer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "message.delete",
      payload: { id: msgId, peerId: peer.id }
    }));
    setMessages((prev) => prev.filter((m) => m.id !== msgId));
  };

  const clearChat = async () => {
    if (!peer || !token) return;
    if (!confirm("Видалити всі повідомлення з цим контактом?")) return;
    try {
      await fetch(`${API_URL}/messages/${peer.id}`, {
        method: "DELETE", headers: authHeaders
      });
      setMessages([]);
      fetchChats();
      setStatus("Чат очищено.");
    } catch { setStatus("Помилка очищення чату."); }
  };

  const handleFile = async (file: File | null) => {
    if (!file || !peer || !keys) return;
    if (!peer.publicKey) { setStatus("У контакта немає публічного ключа."); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const encrypted = encryptBytes(bytes, keys.secretKey, peer.publicKey);
      const blob = new Blob([fromBase64(encrypted.ciphertext) as any], { type: "application/octet-stream" });
      const localUrl = URL.createObjectURL(file);
      const form = new FormData();
      form.append("file", blob, `${file.name}.enc`);
      const res = await fetch(`${API_URL}/files`, {
        method: "POST", headers: authHeaders, body: form
      });
      const data = await res.json();
      await sendMessage("file", "", {
        fileName: file.name, fileType: file.type,
        fileUrl: `${API_URL}${data.url}`,
        nonce: encrypted.nonce, localUrl
      });
    } catch { setStatus("Помилка завантаження файлу."); }
  };

  const decryptFile = async (msg: UiMessage) => {
    if (!msg.meta || !keys || !peer) return;
    if (msg.isMine && msg.meta.localUrl) { window.open(msg.meta.localUrl, "_blank"); return; }
    try {
      const response = await fetch(msg.meta.fileUrl);
      const buffer = new Uint8Array(await response.arrayBuffer());
      const decrypted = decryptBytes(
        msg.meta.nonce, toBase64(buffer),
        msg.meta.senderPublicKey ?? peer.publicKey ?? "", keys.secretKey
      );
      if (!decrypted) { setStatus("Не вдалося розшифрувати файл."); return; }
      const blobOut = new Blob([decrypted as any], { type: msg.meta.fileType || "application/octet-stream" });
      window.open(URL.createObjectURL(blobOut), "_blank");
    } catch { setStatus("Помилка завантаження файлу."); }
  };

  

  // -- Call window --
  const renderCallWindow = () => {
    const win = window.open("", "mas-call", "width=480,height=720");
    if (!win) return null;
    win.document.title = "MAS — Дзвінок";
    const peerDisplay = peer?.login ?? peer?.phone ?? "Абонент";
    const peerInitial = peerDisplay.slice(0, 1).toUpperCase();
    win.document.head.innerHTML = `
      <meta charset="UTF-8">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;
    win.document.body.innerHTML = `
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#0c0f1a;color:#f4f6fb;font-family:'Inter',system-ui,sans-serif;overflow:hidden;user-select:none}
        .wrap{display:flex;flex-direction:column;height:100vh;position:relative}
        .bg{position:absolute;inset:0;z-index:0;overflow:hidden}
        .bg::before{content:'';position:absolute;width:600px;height:600px;top:-200px;left:-100px;border-radius:50%;background:radial-gradient(circle,rgba(59,130,246,0.15),transparent 70%);animation:drift 12s ease-in-out infinite alternate}
        .bg::after{content:'';position:absolute;width:500px;height:500px;bottom:-150px;right:-100px;border-radius:50%;background:radial-gradient(circle,rgba(34,211,238,0.1),transparent 70%);animation:drift 10s ease-in-out infinite alternate-reverse}
        @keyframes drift{0%{transform:translate(0,0)}100%{transform:translate(40px,30px)}}
        .top{position:relative;z-index:1;padding:24px 20px 16px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
        .top .type{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.12em;color:rgba(244,246,251,0.5)}
        .peer-name{font-size:20px;font-weight:700;letter-spacing:0.02em}
        .call-status{font-size:13px;color:rgba(244,246,251,0.6);display:flex;align-items:center;gap:6px}
        .call-status .dot{width:6px;height:6px;border-radius:50%;background:#4ade80;animation:blink 1.5s ease infinite}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
        .timer{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:0.04em;color:rgba(244,246,251,0.85);margin-top:2px}
        .center{flex:1;position:relative;z-index:1;display:flex;align-items:center;justify-content:center}
        .avatar-wrap{display:flex;flex-direction:column;align-items:center;gap:20px}
        .avatar{width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,rgba(59,130,246,0.35),rgba(34,211,238,0.25));display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700;position:relative}
        .avatar::before{content:'';position:absolute;inset:-8px;border-radius:50%;border:2px solid rgba(59,130,246,0.25);animation:ring 2.5s ease-in-out infinite}
        .avatar::after{content:'';position:absolute;inset:-16px;border-radius:50%;border:1px solid rgba(34,211,238,0.12);animation:ring 3s ease-in-out infinite 0.5s}
        @keyframes ring{0%,100%{transform:scale(1);opacity:0.6}50%{transform:scale(1.06);opacity:0.2}}
        .wave-wrap{display:flex;gap:3px;align-items:flex-end;height:28px}
        .wave-bar{width:4px;border-radius:2px;background:linear-gradient(to top,#3b82f6,#22d3ee);animation:wave 1.2s ease-in-out infinite}
        .wave-bar:nth-child(1){height:12px;animation-delay:0s}
        .wave-bar:nth-child(2){height:20px;animation-delay:0.15s}
        .wave-bar:nth-child(3){height:16px;animation-delay:0.3s}
        .wave-bar:nth-child(4){height:24px;animation-delay:0.45s}
        .wave-bar:nth-child(5){height:14px;animation-delay:0.6s}
        @keyframes wave{0%,100%{transform:scaleY(0.4)}50%{transform:scaleY(1)}}
        #remoteVideo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;display:none;background:#111623}
        #localVideo{position:absolute;right:16px;bottom:16px;width:160px;height:200px;object-fit:cover;border-radius:16px;border:2px solid rgba(255,255,255,0.12);z-index:3;display:none;box-shadow:0 8px 24px rgba(0,0,0,0.4);cursor:grab;transition:box-shadow 0.2s}
        #localVideo:hover{box-shadow:0 12px 32px rgba(0,0,0,0.6)}
        .bar{position:relative;z-index:2;padding:16px 24px 28px;display:flex;justify-content:center;gap:16px;background:linear-gradient(to top,rgba(12,15,26,0.85),transparent);backdrop-filter:blur(8px)}
        .btn{width:56px;height:56px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 0.15s,background 0.2s,box-shadow 0.2s;position:relative}
        .btn:hover{transform:scale(1.08)}
        .btn:active{transform:scale(0.95)}
        .btn svg{width:22px;height:22px;fill:none;stroke:#f4f6fb;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
        .btn-default{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.12)}
        .btn-default:hover{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.2)}
        .btn-active{background:rgba(245,158,11,0.25);border:1px solid rgba(245,158,11,0.4)}
        .btn-active svg{stroke:#f59e0b}
        .btn-active:hover{background:rgba(245,158,11,0.35)}
        .btn-end{background:#ef4444;border:1px solid rgba(239,68,68,0.6);box-shadow:0 4px 20px rgba(239,68,68,0.3)}
        .btn-end:hover{background:#dc2626;box-shadow:0 6px 28px rgba(239,68,68,0.4)}
        .btn-end svg{stroke:#fff}
        .btn-label{position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:10px;color:rgba(244,246,251,0.5);white-space:nowrap;letter-spacing:0.04em;font-weight:500}
        .screen-indicator{display:flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:11px;font-weight:600;letter-spacing:0.04em;margin-top:4px;animation:screenPulse 2s ease infinite}
        @keyframes screenPulse{0%,100%{opacity:1}50%{opacity:0.6}}
        .video-overlay .top{background:linear-gradient(to bottom,rgba(12,15,26,0.7),transparent);position:absolute;top:0;left:0;right:0;z-index:2}
        .video-overlay .bar{position:absolute;bottom:0;left:0;right:0;z-index:2}
        .video-overlay .center{display:none}
      </style>
      <div class="wrap" id="callWrap">
        <div class="bg"></div>
        <div class="top">
          <div class="type" id="callLabel">Дзвінок</div>
          <div class="peer-name" id="peerName"></div>
          <div class="call-status" id="statusLabel"><span class="dot"></span><span id="statusText">З'єднання…</span></div>
          <div class="timer" id="timerLabel">00:00</div>
          <div class="screen-indicator" id="screenIndicator" style="display:none">
            <svg viewBox="0 0 24 24" width="14" height="14"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/><line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="2"/><line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" stroke-width="2"/></svg>
            <span>Трансляція екрану</span>
          </div>
        </div>
        <div class="center" id="centerArea">
          <div class="avatar-wrap">
            <div class="avatar" id="avatarEl"></div>
            <div class="wave-wrap" id="waveWrap">
              <div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div>
            </div>
          </div>
        </div>
        <video id="remoteVideo" autoplay playsinline></video>
        <video id="localVideo" autoplay playsinline muted></video>
        <div class="bar">
          <button class="btn btn-default" id="micBtn" title="Мікрофон">
            <svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            <span class="btn-label">Мікрофон</span>
          </button>
          <button class="btn btn-default" id="camBtn" title="Камера">
            <svg viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            <span class="btn-label">Камера</span>
          </button>
          <button class="btn btn-end" id="endCallBtn" title="Завершити">
            <svg viewBox="0 0 24 24"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.15-1.15a1 1 0 0 1 .9-.27 11.4 11.4 0 0 0 3.87.65 1 1 0 0 1 .99 1v3.5a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.22 2.6.65 3.87a1 1 0 0 1-.27.9z" stroke="#fff" fill="none"/><line x1="1" y1="1" x2="23" y2="23" stroke="#fff"/></svg>
            <span class="btn-label">Завершити</span>
          </button>
          <button class="btn btn-default" id="screenBtn" title="Демонстрація екрану">
            <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span class="btn-label">Екран</span>
          </button>
          <button class="btn btn-default" id="fullscreenBtn" title="На весь екран">
            <svg viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            <span class="btn-label">Екран</span>
          </button>
        </div>
      </div>`;

    const peerNameEl = win.document.getElementById("peerName");
    const avatarEl = win.document.getElementById("avatarEl");
    if (peerNameEl) peerNameEl.textContent = peerDisplay;
    if (avatarEl) avatarEl.textContent = peerInitial;

    const $ = (id: string) => win.document.getElementById(id);
    const endButton = $("endCallBtn");
    if (endButton) endButton.addEventListener("click", () => endCall());

    const micBtn = $("micBtn") as HTMLButtonElement | null;
    if (micBtn) micBtn.addEventListener("click", () => toggleMic());

    const camBtn = $("camBtn") as HTMLButtonElement | null;
    if (camBtn) camBtn.addEventListener("click", () => toggleCamera());

    const fullscreenBtn = $("fullscreenBtn") as HTMLButtonElement | null;
    if (fullscreenBtn) fullscreenBtn.addEventListener("click", () => {
      if (!win.document.fullscreenElement) win.document.documentElement.requestFullscreen().catch(() => {});
      else win.document.exitFullscreen().catch(() => {});
    });

    const screenBtn = $("screenBtn") as HTMLButtonElement | null;
    if (screenBtn) screenBtn.addEventListener("click", () => shareScreen());

    const localVideo = $("localVideo") as HTMLVideoElement | null;
    if (localVideo) {
      let dragging = false, ox = 0, oy = 0;
      localVideo.addEventListener("mousedown", (e) => {
        dragging = true; ox = e.offsetX; oy = e.offsetY;
        localVideo.style.cursor = "grabbing";
      });
      win.document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        localVideo.style.right = "auto"; localVideo.style.bottom = "auto";
        localVideo.style.left = `${e.clientX - ox}px`;
        localVideo.style.top = `${e.clientY - oy}px`;
      });
      win.document.addEventListener("mouseup", () => { dragging = false; localVideo.style.cursor = "grab"; });
    }

    const timerLabel = $("timerLabel") as HTMLDivElement | null;
    const timerInterval = win.setInterval(() => {
      const parts = callWindowPartsRef.current;
      if (!parts?.timerStartTime) {
        if (timerLabel) timerLabel.textContent = "00:00";
        return;
      }
      const elapsed = Math.floor((Date.now() - parts.timerStartTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const s = String(elapsed % 60).padStart(2, "0");
      if (timerLabel) timerLabel.textContent = `${m}:${s}`;
    }, 1000) as unknown as number;

    callWindowPartsRef.current = {
      localVideo: localVideo ?? undefined,
      remoteVideo: $("remoteVideo") as HTMLVideoElement | undefined,
      label: $("callLabel") as HTMLDivElement | undefined,
      peerName: $("peerName") as HTMLDivElement | undefined,
      statusLabel: $("statusText") as HTMLDivElement | undefined,
      timerLabel: timerLabel ?? undefined,
      avatar: $("avatarEl") as HTMLDivElement | undefined,
      micBtn: micBtn ?? undefined,
      camBtn: camBtn ?? undefined,
      fullscreenBtn: fullscreenBtn ?? undefined,
      timerInterval,
      timerStartTime: undefined,
    };
    return win;
  };

  const toggleMic = () => {
    const stream = callRef.current.localStream;
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const parts = callWindowPartsRef.current;
    if (parts?.micBtn) {
      parts.micBtn.className = track.enabled ? "btn btn-default" : "btn btn-active";
    }
  };

  const toggleCamera = async () => {
    const pc = callRef.current.pc;
    const stream = callRef.current.localStream;
    if (!pc || !stream) return;
    const existingTrack = stream.getVideoTracks()[0];

    if (existingTrack) {
      existingTrack.enabled = !existingTrack.enabled;
      const parts = callWindowPartsRef.current;
      if (parts?.camBtn) parts.camBtn.className = existingTrack.enabled ? "btn btn-default" : "btn btn-active";
      if (parts?.localVideo) parts.localVideo.style.opacity = existingTrack.enabled ? "1" : "0.3";
      return;
    }

    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const camTrack = camStream.getVideoTracks()[0];
      stream.addTrack(camTrack);
      pc.addTrack(camTrack, stream);

      if (pc.signalingState !== "closed") {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const targetId = peerRef.current?.id ?? callRef.current.callerId;
        if (targetId && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "call.offer",
            payload: { to: targetId, offer: pc.localDescription, isVideo: true, renegotiate: true }
          }));
        }
      }

      setCall((prev) => ({ ...prev, isVideo: true, localStream: stream }));
      const parts = callWindowPartsRef.current;
      if (parts?.camBtn) parts.camBtn.className = "btn btn-default";
      if (parts?.localVideo) {
        parts.localVideo.srcObject = stream;
        parts.localVideo.style.display = "block";
        parts.localVideo.style.opacity = "1";
      }
      switchCallWindowToVideo();
    } catch {
      setStatus("Не вдалося увімкнути камеру.");
    }
  };

  const switchCallWindowToVideo = () => {
    const win = callWindowRef.current;
    if (!win) return;
    const parts = callWindowPartsRef.current;
    if (parts?.label) parts.label.textContent = "ВІДЕОДЗВІНОК";
    if (parts?.remoteVideo) parts.remoteVideo.style.display = "block";
    if (parts?.localVideo) parts.localVideo.style.display = "block";
    const wrap = win.document.getElementById("callWrap");
    const centerArea = win.document.getElementById("centerArea");
    wrap?.classList.add("video-overlay");
    if (centerArea) centerArea.style.display = "none";
  };

  const stopScreenShare = () => {
    const ss = screenShareRef.current;
    if (!ss) return;
    ss.stream.getTracks().forEach((t) => t.stop());
    const pc = callRef.current.pc;
    if (pc && ss.sender) {
      if (ss.originalTrack) {
        ss.sender.replaceTrack(ss.originalTrack);
      } else {
        pc.removeTrack(ss.sender);
        if (pc.signalingState !== "closed") {
          pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => {
            const targetId = peerRef.current?.id ?? callRef.current.callerId;
            if (targetId && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: "call.offer", payload: { to: targetId, offer: pc.localDescription, isVideo: callRef.current.isVideo, renegotiate: true }
              }));
            }
          }).catch(() => {});
        }
      }
    }
    screenShareRef.current = null;
    updateScreenBtnState(false);
    updateCallWindowScreenMode(false);
  };

  const shareScreen = async () => {
    if (screenShareRef.current) { stopScreenShare(); return; }
    const pc = callRef.current.pc;
    if (!pc) return;
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      const existingSender = pc.getSenders().find((s) => s.track?.kind === "video");
      let sender: RTCRtpSender;
      let originalTrack: MediaStreamTrack | null = null;

      if (existingSender) {
        originalTrack = existingSender.track;
        await existingSender.replaceTrack(screenTrack);
        sender = existingSender;
      } else {
        sender = pc.addTrack(screenTrack, screenStream);
        if (pc.signalingState !== "closed") {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const targetId = peerRef.current?.id ?? callRef.current.callerId;
          if (targetId && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "call.offer", payload: { to: targetId, offer: pc.localDescription, isVideo: callRef.current.isVideo, renegotiate: true }
            }));
          }
        }
      }

      screenShareRef.current = { stream: screenStream, originalTrack, sender };
      updateScreenBtnState(true);
      updateCallWindowScreenMode(true);

      const parts = callWindowPartsRef.current;
      if (parts?.localVideo) {
        parts.localVideo.srcObject = screenStream;
        parts.localVideo.style.display = "block";
        parts.localVideo.style.opacity = "1";
      }

      screenTrack.onended = () => stopScreenShare();
    } catch { /* user cancelled picker */ }
  };

  const updateScreenBtnState = (active: boolean) => {
    const win = callWindowRef.current;
    if (!win) return;
    const btn = win.document.getElementById("screenBtn");
    if (btn) btn.className = active ? "btn btn-active" : "btn btn-default";
    const indicator = win.document.getElementById("screenIndicator");
    if (indicator) indicator.style.display = active ? "flex" : "none";
  };

  const updateCallWindowScreenMode = (sharing: boolean) => {
    const win = callWindowRef.current;
    if (!win) return;
    const wrap = win.document.getElementById("callWrap");
    const centerArea = win.document.getElementById("centerArea");
    if (sharing && !callRef.current.isVideo) {
      wrap?.classList.add("video-overlay");
      if (centerArea) centerArea.style.display = "none";
      const parts = callWindowPartsRef.current;
      if (parts?.localVideo) {
        parts.localVideo.style.display = "block";
        parts.localVideo.style.width = "100%";
        parts.localVideo.style.height = "100%";
        parts.localVideo.style.position = "absolute";
        parts.localVideo.style.inset = "0";
        parts.localVideo.style.borderRadius = "0";
        parts.localVideo.style.border = "none";
        parts.localVideo.style.zIndex = "0";
        parts.localVideo.style.cursor = "default";
      }
    } else if (!sharing && !callRef.current.isVideo) {
      wrap?.classList.remove("video-overlay");
      if (centerArea) centerArea.style.display = "flex";
      const parts = callWindowPartsRef.current;
      if (parts?.localVideo) {
        parts.localVideo.style.display = "none";
        parts.localVideo.srcObject = callRef.current.localStream ?? null;
        parts.localVideo.style.width = ""; parts.localVideo.style.height = "";
        parts.localVideo.style.position = ""; parts.localVideo.style.inset = "";
        parts.localVideo.style.borderRadius = ""; parts.localVideo.style.border = "";
        parts.localVideo.style.zIndex = ""; parts.localVideo.style.cursor = "";
      }
    } else if (!sharing && callRef.current.isVideo) {
      const parts = callWindowPartsRef.current;
      if (parts?.localVideo) {
        parts.localVideo.srcObject = callRef.current.localStream ?? null;
      }
    }
  };

  const ensureCallWindow = (isVideo: boolean) => {
    if (!callWindowRef.current || callWindowRef.current.closed) callWindowRef.current = renderCallWindow();
    const parts = callWindowPartsRef.current;
    if (!parts) return;
    const win = callWindowRef.current;

    if (parts.label) parts.label.textContent = isVideo ? "ВІДЕОДЗВІНОК" : "АУДІОДЗВІНОК";

    const peerDisplay = peer?.login ?? peer?.phone ?? "Абонент";
    if (parts.peerName) parts.peerName.textContent = peerDisplay;

    if (parts.remoteVideo) parts.remoteVideo.style.display = isVideo ? "block" : "none";
    if (parts.localVideo) parts.localVideo.style.display = isVideo ? "block" : "none";

    const wrap = win?.document.getElementById("callWrap");
    const centerArea = win?.document.getElementById("centerArea");
    const waveWrap = win?.document.getElementById("waveWrap");
    if (isVideo) {
      wrap?.classList.add("video-overlay");
      if (centerArea) centerArea.style.display = "none";
    } else {
      wrap?.classList.remove("video-overlay");
      if (centerArea) centerArea.style.display = "flex";
      if (waveWrap) waveWrap.style.display = "flex";
    }

    if (call.status === "in-call") {
      if (parts.statusLabel) parts.statusLabel.textContent = "Активний дзвінок";
      if (!parts.timerStartTime) parts.timerStartTime = Date.now();
    }
    if (call.status === "calling" && parts.statusLabel) parts.statusLabel.textContent = "Виклик…";
  };

  const syncCallWindowStreams = (localStream?: MediaStream, remoteStream?: MediaStream) => {
    const parts = callWindowPartsRef.current;
    if (!parts) return;
    if (parts.localVideo && localStream) parts.localVideo.srcObject = localStream;
    if (parts.remoteVideo && remoteStream) parts.remoteVideo.srcObject = remoteStream;
  };

  const closeCallWindow = () => {
    if (callWindowPartsRef.current?.timerInterval) {
      callWindowRef.current?.clearInterval(callWindowPartsRef.current.timerInterval);
    }
    if (callWindowRef.current && !callWindowRef.current.closed) callWindowRef.current.close();
    callWindowRef.current = null; callWindowPartsRef.current = null;
  };

  const stopTone = () => {
    if (toneTimerRef.current) { window.clearInterval(toneTimerRef.current); toneTimerRef.current = null; }
    if (toneOscRef.current) { toneOscRef.current.stop(); toneOscRef.current.disconnect(); toneOscRef.current = null; }
    if (toneGainRef.current) { toneGainRef.current.disconnect(); toneGainRef.current = null; }
  };

  const startTone = (kind: "incoming" | "outgoing") => {
    stopTone();
    if (!toneCtxRef.current) toneCtxRef.current = new AudioContext();
    const ctx = toneCtxRef.current;
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = kind === "incoming" ? 520 : 440;
    gain.gain.value = 0;
    osc.connect(gain); gain.connect(ctx.destination); osc.start();
    toneOscRef.current = osc; toneGainRef.current = gain;
    let on = false;
    toneTimerRef.current = window.setInterval(() => { on = !on; gain.gain.value = on ? 0.2 : 0; }, kind === "incoming" ? 600 : 900);
  };

  const createPeerConnection = () =>
    new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

  const startCall = async (isVideo = false) => {
    if (!peer) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatus("Немає з'єднання."); return;
    }
    try {
      const pc = createPeerConnection();
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          wsRef.current?.send(JSON.stringify({
            type: "call.ice", payload: { to: peer.id, candidate: event.candidate }
          }));
        }
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
        setCall((prev) => ({ ...prev, remoteStream: stream }));
      };
      const localStream = await navigator.mediaDevices.getUserMedia(
        isVideo ? { audio: true, video: true } : { audio: true }
      );
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsRef.current.send(JSON.stringify({
        type: "call.offer", payload: { to: peer.id, offer, isVideo }
      }));
      setCall({ status: "calling", pc, localStream, isVideo });
    } catch (err) {
      setStatus("Не вдалося запустити дзвінок. Перевірте доступ до мікрофона.");
    }
  };

  const acceptCall = async () => {
    if (!call.offer) return;
    stopTone();
    let currentPeer = peer;
    if (!currentPeer && call.callerId) {
      const fetched = await fetchPeerById(call.callerId);
      if (fetched) { setPeer(fetched); currentPeer = fetched; }
    }
    if (!currentPeer) { setStatus("Немає даних співрозмовника."); return; }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatus("Немає з'єднання."); return;
    }
    try {
      const pc = createPeerConnection();
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          wsRef.current?.send(JSON.stringify({
            type: "call.ice", payload: { to: currentPeer!.id, candidate: event.candidate }
          }));
        }
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
        setCall((prev) => ({ ...prev, remoteStream: stream }));
      };
      const localStream = await navigator.mediaDevices.getUserMedia(
        call.isVideo ? { audio: true, video: true } : { audio: true }
      );
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      await pc.setRemoteDescription(call.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsRef.current.send(JSON.stringify({
        type: "call.answer", payload: { to: currentPeer!.id, answer }
      }));
      setCall({ status: "in-call", pc, localStream, isVideo: call.isVideo });
    } catch (err) {
      setStatus("Не вдалося прийняти дзвінок. Перевірте доступ до мікрофона.");
      endCall();
    }
  };

  const endCall = () => {
    if (screenShareRef.current) {
      screenShareRef.current.stream.getTracks().forEach((t) => t.stop());
      screenShareRef.current = null;
    }
    call.pc?.close();
    call.localStream?.getTracks().forEach((track) => track.stop());
    stopTone();
    const targetId = peer?.id ?? call.callerId;
    if (targetId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "call.end", payload: { to: targetId } }));
    }
    closeCallWindow();
    setCall({ status: "idle" });
  };

  useEffect(() => {
    if (call.status === "calling" || call.status === "in-call") {
      ensureCallWindow(Boolean(call.isVideo));
      syncCallWindowStreams(call.localStream, call.remoteStream);
    } else if (call.status === "idle") { closeCallWindow(); }
  }, [call.status, call.isVideo, call.localStream, call.remoteStream]);

  useEffect(() => {
    if (call.status === "incoming") { startTone("incoming"); return; }
    if (call.status === "calling") { startTone("outgoing"); return; }
    stopTone();
  }, [call.status]);

  // -- Render --
  if (!isAuthed) {
    return (
      <div className="auth">
        <h1>MAS Secure</h1>
        <p>Вхід за номером телефону (SMS).</p>
        <div className="phone-row">
          <div className="select-wrapper" ref={selectRef}>
            <button type="button" className="select-trigger" onClick={() => setCountryOpen((p) => !p)}>
              <span>{activeCountry?.name ?? country} (+{activeCountry?.dial ?? dialCode})</span>
              <span className="chevron" />
            </button>
            {countryOpen && (
              <div className="select-panel">
                <input className="select-search" placeholder="Пошук країни або коду"
                  value={countryQuery} onChange={(e) => setCountryQuery(e.target.value)} />
                <div className="select-list">
                  {filteredCountries.map((item) => (
                    <button type="button" key={item.code}
                      className={`select-item ${item.code === country ? "active" : ""}`}
                      onClick={() => { setCountry(item.code); setCountryOpen(false); }}>
                      <span>{item.name}</span>
                      <span className="dial">+{item.dial}</span>
                    </button>
                  ))}
                  {filteredCountries.length === 0 && <div className="select-empty">Нічого не знайдено</div>}
                </div>
              </div>
            )}
          </div>
          <input placeholder="Номер" value={localNumber} onChange={(e) => setLocalNumber(e.target.value)} />
        </div>
        <span className="hint">Повний номер: {fullPhone}</span>
        <button onClick={requestCode}>Отримати код</button>
        {devCode && <span className="hint">Dev-код: {devCode}</span>}
        <input placeholder="Код" value={code} onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") verifyCode(); }} />
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
              <div className="profile-left"><div className="logo">MAS</div></div>
            </div>
            <div className="sidebar-search">
              <input placeholder="Пошук чатів" value={chatQuery}
                onChange={(e) => setChatQuery(e.target.value)} />
            </div>
            {chatQuery.trim().length >= 3 && (
              <div className="chat-people">
                <div className="chat-people-title">Люди</div>
                {loginMatches.length === 0 ? (
                  <div className="chat-empty">Нічого не знайдено</div>
                ) : (
                  loginMatches.map((item) => (
                    <button key={item.id} className="chat-item" onClick={() => handleSelectUser(item)}>
                      <div className="chat-avatar">
                        {(item.login ?? item.phone).slice(0, 1).toUpperCase()}
                        {onlineUserIds.has(item.id) && <span className="chat-dot" />}
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
                  <button key={chat.id}
                    className={`chat-item ${peer?.id === chat.id ? "active" : ""}`}
                    onClick={() => handleSelectChat(chat)}>
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
                    {chat.unread > 0 && <span className="unread-badge">{chat.unread}</span>}
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
            <div className="call-card-btns">
              <button className="call-accept" onClick={acceptCall}>Прийняти</button>
              <button className="call-reject" onClick={endCall}>Відхилити</button>
            </div>
          </div>
        )}
        {call.status === "in-call" && activeTab === "chat" && (
          <div className="call-card">
            <p>Дзвінок активний</p>
            <button className="call-reject" onClick={endCall}>Завершити</button>
          </div>
        )}
        <audio ref={remoteAudioRef} autoPlay />
      </aside>
      <div className="backdrop" onClick={() => setIsMenuOpen(false)} />
      <div className="content">
        <div className="topbar">
          <div className="topbar-left">
            <button className="hamburger" onClick={() => setIsMenuOpen((p) => !p)}>
              <span /><span /><span />
            </button>
            <button className="gear"
              onClick={() => setActiveTab((p) => (p === "settings" ? "chat" : "settings"))}
              aria-label="Налаштування">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19.14 12.94a7.84 7.84 0 0 0 .05-.94 7.84 7.84 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.22-1.12.52-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.03.31-.05.63-.05.94s.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.51.41 1.05.72 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.22 1.12-.52 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"/>
              </svg>
            </button>
          </div>
          <div className="topbar-title">
            {activeTab === "chat" ? (
              peer ? (
                <span>
                  {peer.login ?? peer.phone}
                  {peerTyping && <span className="typing-label"> друкує…</span>}
                  {!peerTyping && onlineUserIds.has(peer.id) && <span className="online-label"> онлайн</span>}
                </span>
              ) : ""
            ) : "Налаштування"}
          </div>
          {activeTab === "chat" && peer && (
            <div className="call-actions">
              <button className="gear" onClick={() => { setChatSearchOpen((p) => !p); setChatSearch(""); }} aria-label="Пошук" title="Пошук в чаті">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
              <button className="gear" onClick={clearChat} aria-label="Очистити чат" title="Очистити чат">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
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
              {chatSearchOpen && (
                <div className="chat-search-bar">
                  <input placeholder="Пошук у чаті…" value={chatSearch} autoFocus
                    onChange={(e) => setChatSearch(e.target.value)} />
                  <span className="chat-search-count">{chatSearch ? `${filteredMessages.length} знайдено` : ""}</span>
                  <button className="ghost" onClick={() => { setChatSearchOpen(false); setChatSearch(""); }}>✕</button>
                </div>
              )}
              {!peer.publicKey && (
                <div className="no-key-banner">
                  <span className="no-key-icon">🔑</span>
                  <div className="no-key-text">
                    <strong>Контакт ще не увійшов у месенджер</strong>
                    <span>Надсилання повідомлень стане доступним після першого входу контакта.</span>
                  </div>
                </div>
              )}
              {messages.some((m) => m.pinned) && (
                <div className="pinned-bar" onClick={() => {
                  const pinned = messages.find((m) => m.pinned);
                  if (pinned) { const el = document.getElementById(`msg-${pinned.id}`); el?.scrollIntoView({ behavior: "smooth" }); }
                }}>
                  📌 {messages.filter((m) => m.pinned).length} закріплене повідомлення
                </div>
              )}
              <div className="messages">
                {(chatSearch ? filteredMessages : messages).map((msg, idx, arr) => {
                  const prev = arr[idx - 1];
                  const showDate = !prev || formatDate(prev.createdAt) !== formatDate(msg.createdAt);
                  const replyMsg = msg.replyToId ? messages.find((m) => m.id === msg.replyToId) : null;
                  return (
                    <React.Fragment key={msg.id}>
                      {showDate && <div className="date-separator"><span>{formatDate(msg.createdAt)}</span></div>}
                      <div id={`msg-${msg.id}`}
                        className={`message ${msg.isMine ? "out" : "in"} ${msg.meta?.decryptFailed ? "decrypt-failed" : ""} ${msg.pinned ? "pinned-msg" : ""}`}
                        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, msg }); }}>
                        {msg.pinned && <div className="pin-badge">📌</div>}
                        {replyMsg && (
                          <div className="reply-preview" onClick={() => {
                            const el = document.getElementById(`msg-${replyMsg.id}`);
                            el?.scrollIntoView({ behavior: "smooth" });
                          }}>
                            <span className="reply-author">{replyMsg.isMine ? "Ви" : (peer?.login ?? peer?.phone)}</span>
                            <span className="reply-text">{replyMsg.text?.slice(0, 60) ?? "..."}</span>
                          </div>
                        )}
                        {msg.meta?.decryptFailed ? (
                          <div className="decrypt-failed-content">
                            <span className="message-text">{msg.text}</span>
                            <button className="decrypt-delete-btn" onClick={() => deleteMessage(msg.id)}>Видалити</button>
                          </div>
                        ) : msg.contentType === "file" && msg.meta ? (
                          <button className="file-btn" onClick={() => decryptFile(msg)}>📎 {msg.meta.fileName}</button>
                        ) : (
                          <span className="message-text">{msg.text}</span>
                        )}
                        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                          <div className="reactions-row">
                            {Object.entries(msg.reactions).map(([emoji, users]) => (
                              <button key={emoji} className={`reaction-chip ${(users as string[]).includes(user?.id ?? "") ? "my-reaction" : ""}`}
                                onClick={() => reactToMessage(msg.id, emoji)}>
                                {emoji} {(users as string[]).length}
                              </button>
                            ))}
                            <button className="reaction-chip add-reaction" onClick={() => setReactionPicker(reactionPicker === msg.id ? null : msg.id)}>+</button>
                          </div>
                        )}
                        {reactionPicker === msg.id && (
                          <div className="reaction-picker-row">
                            {quickReactions.map((e) => (
                              <button key={e} className="reaction-pick" onClick={() => reactToMessage(msg.id, e)}>{e}</button>
                            ))}
                          </div>
                        )}
                        <div className="message-meta">
                          {msg.editedAt && <span className="edited-label">ред.</span>}
                          <span className="message-time">{formatTime(msg.createdAt)}</span>
                          {msg.isMine && !msg.meta?.decryptFailed && (
                            <span className={`message-status ${msg.status ?? "sent"}`}>
                              {msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : "✓"}
                            </span>
                          )}
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              {ctxMenu && (
                <div className="ctx-menu" style={{ top: Math.min(ctxMenu.y, window.innerHeight - 300), left: Math.min(ctxMenu.x, window.innerWidth - 220) }}>
                  <div className="ctx-reactions">
                    {quickReactions.map((e) => (
                      <button key={e} className="ctx-react-btn" onClick={() => { reactToMessage(ctxMenu.msg.id, e); setCtxMenu(null); }}>{e}</button>
                    ))}
                  </div>
                  <div className="ctx-divider" />
                  <button className="ctx-item" onClick={() => { startReply(ctxMenu.msg); }}><span className="ctx-icon">↩</span>Відповісти</button>
                  {ctxMenu.msg.isMine && <button className="ctx-item" onClick={() => { startEdit(ctxMenu.msg); }}><span className="ctx-icon">✏️</span>Редагувати</button>}
                  <button className="ctx-item" onClick={() => { copyMessageText(ctxMenu.msg.text ?? ""); setCtxMenu(null); }}><span className="ctx-icon">📋</span>Копіювати</button>
                  <button className="ctx-item" onClick={() => { pinMessage(ctxMenu.msg.id); setCtxMenu(null); }}><span className="ctx-icon">📌</span>{ctxMenu.msg.pinned ? "Відкріпити" : "Закріпити"}</button>
                  {ctxMenu.msg.isMine && (<><div className="ctx-divider" /><button className="ctx-item ctx-danger" onClick={() => { deleteMessage(ctxMenu.msg.id); setCtxMenu(null); }}><span className="ctx-icon">🗑</span>Видалити</button></>)}
                </div>
              )}
              <div className="composer">
                {showEmoji && (
                  <div className="emoji-picker">
                    <div className="emoji-header">
                      <input className="emoji-search" placeholder="Пошук емодзі…" value={emojiSearch}
                        onChange={(e) => setEmojiSearch(e.target.value)} autoFocus />
                    </div>
                    <div className="emoji-tabs">
                      {Object.keys(emojiCategories).map((cat) => (
                        <button key={cat} className={`emoji-tab ${emojiCategory === cat ? "active" : ""}`}
                          onClick={() => { setEmojiCategory(cat); setEmojiSearch(""); }}>
                          {cat === "Обличчя" ? "😀" : cat === "Жести" ? "👋" : cat === "Серця" ? "❤️" : cat === "Об'єкти" ? "⭐" : "✅"}
                        </button>
                      ))}
                    </div>
                    <div className="emoji-grid">
                      {(emojiSearch
                        ? allEmojis.filter((e) => e.includes(emojiSearch))
                        : emojiCategories[emojiCategory] ?? []
                      ).map((e) => (
                        <button key={e} className="emoji-btn" onClick={() => setMsgInput((p) => p + e)}>{e}</button>
                      ))}
                    </div>
                  </div>
                )}
                {(replyTo || editingMsg) && (
                  <div className="composer-reply-bar">
                    <div className="composer-reply-info">
                      <span className="composer-reply-label">{editingMsg ? "✏ Редагування" : `↩ ${replyTo?.isMine ? "Ви" : (peer?.login ?? peer?.phone)}`}</span>
                      <span className="composer-reply-text">{(editingMsg ?? replyTo)?.text?.slice(0, 80)}</span>
                    </div>
                    <button className="composer-reply-close" onClick={cancelReplyEdit}>✕</button>
                  </div>
                )}
                <div className="composer-row">
                  <button className="emoji-toggle" onClick={() => setShowEmoji((p) => !p)}>😀</button>
                  <textarea placeholder="Повідомлення" value={msgInput} rows={1}
                    onChange={(e) => { setMsgInput(e.target.value); sendTyping(); if (showEmoji) setShowEmoji(false); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendText(); } }} />
                  <button className="send-btn" onClick={handleSendText} disabled={!msgInput.trim()}>
                    <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  </button>
                  <label className="attach-btn" aria-label="Завантажити файл">
                    <input type="file" onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M16.5 6.5 8.5 14.5a2.5 2.5 0 0 0 3.54 3.54l8.25-8.25a4 4 0 0 0-5.66-5.66l-8.6 8.6a5.5 5.5 0 0 0 7.78 7.78l8.07-8.07"/>
                    </svg>
                  </label>
                </div>
              </div>
            </>
          ) : (
            <div className="chat-placeholder">
              <div>
                <h2>MAS Secure Messenger</h2>
                <p>Оберіть чат або знайдіть контакт через пошук</p>
              </div>
            </div>
          )
        ) : (
          <div className="settings">
            <h2>Налаштування</h2>
            <div className="settings-grid">
              <section className="settings-section">
                <h3>Програма</h3>
                <label className="settings-row">
                  <span>Сповіщення</span>
                  <input className="toggle" type="checkbox" checked={notificationsEnabled}
                    onChange={(e) => setNotificationsEnabled(e.target.checked)} />
                </label>
                <label className="settings-row">
                  <span>Запускати при старті системи</span>
                  <input className="toggle" type="checkbox" checked={startOnBoot}
                    onChange={(e) => setStartOnBoot(e.target.checked)} />
                </label>
              </section>
              <section className="settings-section">
                <h3>Акаунт</h3>
                <label className="settings-row column">
                  <span>Ім'я користувача</span>
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </label>
                <label className="settings-row column">
                  <span>Логін</span>
                  <input value={loginValue} onChange={(e) => setLoginValue(e.target.value)} placeholder="наприклад: mas_user" />
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
                <h3>Конфіденційність</h3>
                <label className="settings-row">
                  <span>Звіти про прочитання</span>
                  <input className="toggle" type="checkbox" checked={readReceipts}
                    onChange={(e) => setReadReceipts(e.target.checked)} />
                </label>
                <label className="settings-row">
                  <span>Індикатор набору</span>
                  <input className="toggle" type="checkbox" checked={typingIndicator}
                    onChange={(e) => setTypingIndicator(e.target.checked)} />
                </label>
                <label className="settings-row">
                  <span>Останній онлайн</span>
                  <input className="toggle" type="checkbox" checked={lastSeenVisible}
                    onChange={(e) => setLastSeenVisible(e.target.checked)} />
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

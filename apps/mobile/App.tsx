import "react-native-get-random-values";
import "react-native-url-polyfill/auto";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  View,
} from "react-native";
import { BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { RTCView } from "react-native-webrtc";
import {
  DEFAULT_API_URL,
  DEFAULT_CHAT_MODE,
  DEFAULT_ICE_SERVERS,
  SERVER_URL_PLACEHOLDER,
  authHeaders,
  fetchClientConfig,
  jsonHeaders,
  normalizeApiUrl,
  parseQrPayload,
  readIceServers,
  resolveWsUrl,
} from "./src/api";
import { createPeerConnection, getUserCallMedia, stopStreamTracks, toIceCandidate, toSessionDescription } from "./src/calls";
import { decryptAndShareFile, shareCloudFile, uploadCloudFile, uploadEncryptedFile } from "./src/files";
import { initializeKeys, restoreAndStoreKeys, saveKeyBackup } from "./src/keys";
import { buildCloudMessagePayload, buildEncryptedMessagePayload, decryptIncomingMessage } from "./src/messages";
import {
  clearStoredKeys,
  clearToken,
  loadApiUrl,
  loadToken,
  saveApiUrl as saveApiUrlValue,
  saveStoredKeys,
  saveToken,
} from "./src/storage";
import { colors, styles } from "./src/styles";
import type {
  CallState,
  ChatSummary,
  ChatMode,
  IceCandidateInit,
  IceServer,
  KeyPairState,
  KeyStatus,
  QrPayload,
  SessionDescriptionInit,
  UiMessage,
  User,
} from "./src/types";

type ViewName = "chats" | "chat" | "qr" | "settings";

const quickReactions = ["+1", "heart", "haha", "wow", "sad", "fire"];

const randomId = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};

const displayName = (user?: User | null) => user?.login || user?.phone || "Contact";

const formatTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const messagePreview = (type: UiMessage["contentType"]) => {
  if (type === "file") return "File";
  if (type === "voice") return "Voice";
  if (type === "call") return "Call";
  if (type === "gif") return "GIF";
  if (type === "sticker") return "Sticker";
  return "Message";
};

const isDecryptFailed = (message: UiMessage) => message.meta?.decryptFailed === "true";

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [loading, setLoading] = useState(true);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [serverUrlInput, setServerUrlInput] = useState(DEFAULT_API_URL);
  const [chatMode, setChatMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [keys, setKeys] = useState<KeyPairState | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ state: "checking" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [status, setStatus] = useState("");
  const [activeView, setActiveView] = useState<ViewName>("chats");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsError, setChatsError] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [peer, setPeer] = useState<User | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const [selectedMessage, setSelectedMessage] = useState<UiMessage | null>(null);
  const [replyTo, setReplyTo] = useState<UiMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<UiMessage | null>(null);
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [peerTyping, setPeerTyping] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [pendingQr, setPendingQr] = useState<QrPayload | null>(null);
  const [restorePin, setRestorePin] = useState("");
  const [backupPin, setBackupPin] = useState("");
  const [iceServers, setIceServers] = useState<IceServer[]>(DEFAULT_ICE_SERVERS);
  const [call, setCall] = useState<CallState>({ status: "idle" });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userRef = useRef<User | null>(null);
  const keysRef = useRef<KeyPairState | null>(null);
  const peerRef = useRef<User | null>(null);
  const activeViewRef = useRef<ViewName>("chats");
  const callRef = useRef<CallState>({ status: "idle" });
  const pendingIceCandidatesRef = useRef<Record<string, IceCandidateInit[]>>({});
  const fetchChatsRef = useRef<() => void>(() => {});

  const signedIn = Boolean(token && user);
  const wsUrl = useMemo(() => resolveWsUrl(apiUrl), [apiUrl]);
  const canRequestCode = phone.trim().length >= 5;

  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { keysRef.current = keys; }, [keys]);
  useEffect(() => { peerRef.current = peer; }, [peer]);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  useEffect(() => { callRef.current = call; }, [call]);

  const setCallState = useCallback((next: CallState) => {
    callRef.current = next;
    setCall(next);
  }, []);

  const setStatusForAWhile = useCallback((value: string) => {
    setStatus(value);
  }, []);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 9000);
    return () => clearTimeout(timer);
  }, [status]);

  const expireSession = useCallback(async (message = "Session expired, sign in again.") => {
    await clearToken();
    setToken(null);
    setUser(null);
    setKeys(null);
    setPeer(null);
    setMessages([]);
    setChats([]);
    setPendingQr(null);
    setScannerOpen(false);
    setChatsError("");
    setActiveView("chats");
    setChatMode(DEFAULT_CHAT_MODE);
    setKeyStatus({ state: "blocked", reason: "Not signed in." });
    shouldReconnectRef.current = false;
    wsRef.current?.close();
    wsRef.current = null;
    setStatusForAWhile(message);
  }, [setStatusForAWhile]);

  const runKeyInitialization = useCallback(async (nextApiUrl: string, nextToken: string, nextUser: User) => {
    setKeyStatus({ state: "checking" });
    try {
      const result = await initializeKeys(nextApiUrl, nextToken, nextUser);
      setKeys(result.keys);
      setUser(result.user);
      setKeyStatus(result.status);
      if (result.status.state === "restore-required") {
        setActiveView("settings");
        setStatusForAWhile(result.status.backupAvailable
          ? "Enter MAS PIN to restore encryption keys."
          : "This account has a key on another device but no backup was found.");
      }
    } catch {
      setKeys(null);
      setKeyStatus({ state: "blocked", reason: "Could not initialize encryption keys." });
    }
  }, [setStatusForAWhile]);

  const configureChatForUser = useCallback(async (nextApiUrl: string, nextToken: string, nextUser: User) => {
    const config = await fetchClientConfig(nextApiUrl);
    setChatMode(config.chatMode);
    if (config.chatMode === "cloud") {
      setKeys(null);
      setKeyStatus({ state: "ready" });
      return;
    }
    await runKeyInitialization(nextApiUrl, nextToken, nextUser);
  }, [runKeyInitialization]);

  useEffect(() => {
    (async () => {
      const nextApiUrl = await loadApiUrl();
      setApiUrl(nextApiUrl);
      setServerUrlInput(nextApiUrl);
      const savedToken = await loadToken();
      if (!savedToken) {
        setLoading(false);
        setKeyStatus({ state: "blocked", reason: "Not signed in." });
        return;
      }
      try {
        const res = await fetch(`${nextApiUrl}/users/me`, { headers: authHeaders(savedToken) });
        if (!res.ok) throw new Error("unauthorized");
        const nextUser = (await res.json()) as User;
        setToken(savedToken);
        setUser(nextUser);
        await configureChatForUser(nextApiUrl, savedToken, nextUser);
      } catch {
        await clearToken();
        setToken(null);
        setUser(null);
        setKeyStatus({ state: "blocked", reason: "Not signed in." });
        setStatusForAWhile("Session expired, sign in again.");
      } finally {
        setLoading(false);
      }
    })();
  }, [configureChatForUser, setStatusForAWhile]);

  const saveServerUrl = useCallback(async () => {
    const normalized = normalizeApiUrl(serverUrlInput);
    if (!normalized) {
      setStatusForAWhile(`Enter a valid http(s) Server URL, for example ${SERVER_URL_PLACEHOLDER}.`);
      return false;
    }
    setApiUrl(normalized);
    setServerUrlInput(normalized);
    await saveApiUrlValue(normalized);
    setStatusForAWhile("Server URL saved.");
    if (token) {
      try {
        const res = await fetch(`${normalized}/users/me`, { headers: authHeaders(token) });
        if (res.status === 401) {
          await expireSession();
          return true;
        }
        if (res.ok) {
          const nextUser = (await res.json()) as User;
          setUser(nextUser);
          await configureChatForUser(normalized, token, nextUser);
        }
      } catch {
        setStatusForAWhile("Server URL saved, but this server is not reachable now.");
      }
    }
    return true;
  }, [configureChatForUser, expireSession, serverUrlInput, setStatusForAWhile, token]);

  const fetchChats = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${apiUrl}/chats`, { headers: authHeaders(token) });
      if (res.status === 401) {
        await expireSession();
        return;
      }
      if (!res.ok) {
        setChatsError("Could not load chats.");
        setStatusForAWhile("Could not load chats.");
        return;
      }
      setChats((await res.json()) as ChatSummary[]);
      setChatsError("");
    } catch {
      setChatsError("Could not load chats. Check connection.");
      setStatusForAWhile("Could not load chats. Check connection.");
    }
  }, [apiUrl, expireSession, setStatusForAWhile, token]);

  useEffect(() => {
    fetchChatsRef.current = () => { void fetchChats(); };
  }, [fetchChats]);

  useEffect(() => {
    if (!token) return;
    fetchChats();
  }, [fetchChats, token]);

  useEffect(() => {
    if (!token) {
      setIceServers(DEFAULT_ICE_SERVERS);
      return;
    }
    let cancelled = false;
    fetch(`${apiUrl}/config/ice`, { headers: authHeaders(token) })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (cancelled || !data) return;
        setIceServers(readIceServers((data as { iceServers?: unknown }).iceServers) ?? DEFAULT_ICE_SERVERS);
      })
      .catch(() => {
        if (!cancelled) setIceServers(DEFAULT_ICE_SERVERS);
      });
    return () => { cancelled = true; };
  }, [apiUrl, token]);

  const fetchPeerById = useCallback(async (peerId: string) => {
    if (!token) return null;
    try {
      const res = await fetch(`${apiUrl}/users/${peerId}`, { headers: authHeaders(token) });
      if (!res.ok) return null;
      return (await res.json()) as User;
    } catch {
      return null;
    }
  }, [apiUrl, token]);

  const sendReadReceipts = useCallback((peerId: string, ids: string[]) => {
    const socket = wsRef.current;
    if (!ids.length || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "message.read", payload: { peerId, ids } }));
  }, []);

  const loadMessages = useCallback(async (peerId: string, nextPeer?: User | null) => {
    if (!token || !userRef.current) return;
    const currentKeys = keysRef.current;
    if (chatMode !== "cloud" && !currentKeys) {
      setStatusForAWhile("Restore encryption keys before opening chats.");
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/messages/${peerId}?limit=100&offset=0`, { headers: authHeaders(token) });
      if (res.status === 401) {
        await expireSession();
        return;
      }
      if (!res.ok) return;
      const raw = await res.json();
      const peerForDecrypt = nextPeer ?? peerRef.current;
      const mapped = (Array.isArray(raw) ? raw : []).map((item) =>
        decryptIncomingMessage(item, userRef.current?.id ?? "", currentKeys, peerForDecrypt, chatMode)
      );
      setMessages(mapped);
      setUnreadMap((prev) => ({ ...prev, [peerId]: 0 }));
      sendReadReceipts(peerId, mapped.filter((msg) => !msg.isMine).map((msg) => msg.id));
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    } catch {
      setStatusForAWhile("Could not load messages.");
    }
  }, [apiUrl, chatMode, expireSession, sendReadReceipts, setStatusForAWhile, token]);

  const openPeer = useCallback(async (nextPeer: User) => {
    setSelectedMessage(null);
    setReplyTo(null);
    setEditingMessage(null);
    setPeer(nextPeer);
    setActiveView("chat");
    await loadMessages(nextPeer.id, nextPeer);
  }, [loadMessages]);

  const openChat = useCallback(async (chat: ChatSummary) => {
    const fetched = await fetchPeerById(chat.peerId);
    await openPeer(fetched ?? {
      id: chat.peerId,
      phone: chat.peerPhone,
      login: chat.peerLogin,
      publicKey: chat.peerPublicKey,
    });
  }, [fetchPeerById, openPeer]);

  useEffect(() => {
    if (!token || chatQuery.trim().length < 3) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${apiUrl}/users/search?query=${encodeURIComponent(chatQuery.trim())}`, {
          headers: authHeaders(token),
        });
        setSearchResults(res.ok ? (await res.json()) as User[] : []);
      } catch {
        setSearchResults([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [apiUrl, chatQuery, token]);

  const sendCallSignal = useCallback((
    type: "call.offer" | "call.answer" | "call.ice" | "call.end",
    peerId: string,
    payload: Record<string, unknown> = {}
  ) => {
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type, payload: { to: peerId, ...payload } }));
    return true;
  }, []);

  const getCallPeerId = useCallback((state = callRef.current) =>
    state.peerId ?? state.callerId ?? peerRef.current?.id,
  []);

  const queueIceCandidate = useCallback((peerId: string, candidate: IceCandidateInit) => {
    const queue = pendingIceCandidatesRef.current[peerId] ?? [];
    if (queue.length < 50) queue.push(candidate);
    pendingIceCandidatesRef.current[peerId] = queue;
  }, []);

  const flushPendingIceCandidates = useCallback(async (pc: any, peerId: string) => {
    const queue = pendingIceCandidatesRef.current[peerId] ?? [];
    delete pendingIceCandidatesRef.current[peerId];
    for (const item of queue) {
      try {
        await pc.addIceCandidate(toIceCandidate(item));
      } catch {
        // stale candidate
      }
    }
  }, []);

  const configurePeerConnection = useCallback((pc: any, peerId: string) => {
    pc.onicecandidate = (event: { candidate?: unknown }) => {
      if (event.candidate) sendCallSignal("call.ice", peerId, { candidate: event.candidate });
    };
    pc.ontrack = (event: { streams?: any[]; stream?: any }) => {
      const stream = event.streams?.[0] ?? event.stream;
      if (!stream) return;
      setCall((prev) => {
        const next = {
          ...prev,
          remoteStream: stream,
          isVideo: prev.isVideo || stream.getVideoTracks().length > 0,
        };
        callRef.current = next;
        return next;
      });
    };
  }, [sendCallSignal]);

  const renegotiateCall = useCallback(async (pc: any, peerId: string, isVideo: boolean) => {
    if (pc.signalingState === "closed") return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendCallSignal("call.offer", peerId, { offer: pc.localDescription ?? offer, isVideo, renegotiate: true });
  }, [sendCallSignal]);

  const endCall = useCallback(({ notifyPeer = true, peerId }: { notifyPeer?: boolean; peerId?: string } = {}) => {
    const current = callRef.current;
    const targetId = peerId ?? getCallPeerId(current);
    if (notifyPeer && targetId) sendCallSignal("call.end", targetId);
    current.pc?.close();
    stopStreamTracks(current.localStream);
    stopStreamTracks(current.remoteStream);
    pendingIceCandidatesRef.current = {};
    setCallState({ status: "idle" });
  }, [getCallPeerId, sendCallSignal, setCallState]);

  const handleRemoteIceCandidate = useCallback(async (peerId: string, candidate: IceCandidateInit) => {
    const current = callRef.current;
    const pc = current.pc as any;
    if (!pc || current.peerId !== peerId || !pc.remoteDescription) {
      queueIceCandidate(peerId, candidate);
      return;
    }
    try {
      await pc.addIceCandidate(toIceCandidate(candidate));
    } catch {
      // stale candidate
    }
  }, [queueIceCandidate]);

  const handleRenegotiateOffer = useCallback(async (
    peerId: string,
    offer: SessionDescriptionInit,
    remoteWantsVideo: boolean
  ) => {
    const current = callRef.current;
    const pc = current.pc as any;
    if (!pc || current.status !== "in-call" || current.peerId !== peerId) {
      sendCallSignal("call.end", peerId);
      return;
    }
    try {
      await pc.setRemoteDescription(toSessionDescription(offer));
      await flushPendingIceCandidates(pc, peerId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendCallSignal("call.answer", peerId, { answer: pc.localDescription ?? answer });
      setCall((prev) => {
        const next = { ...prev, isVideo: Boolean(remoteWantsVideo || prev.localStream?.getVideoTracks().length) };
        callRef.current = next;
        return next;
      });
    } catch {
      endCall({ notifyPeer: true, peerId });
    }
  }, [endCall, flushPendingIceCandidates, sendCallSignal]);

  const startCall = useCallback(async (isVideo = false) => {
    const target = peerRef.current;
    if (!target || callRef.current.status !== "idle") return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setStatusForAWhile("No WebSocket connection.");
      return;
    }
    let pc: any = null;
    let localStream: any = null;
    try {
      pc = createPeerConnection(iceServers);
      configurePeerConnection(pc, target.id);
      localStream = await getUserCallMedia(isVideo);
      localStream.getTracks().forEach((track: any) => pc.addTrack(track, localStream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendCallSignal("call.offer", target.id, { offer: pc.localDescription ?? offer, isVideo });
      setCallState({ status: "calling", peerId: target.id, pc, localStream, isVideo });
    } catch {
      pc?.close();
      stopStreamTracks(localStream);
      setStatusForAWhile("Could not start call. Check microphone/camera access.");
    }
  }, [configurePeerConnection, iceServers, sendCallSignal, setCallState, setStatusForAWhile]);

  const acceptCall = useCallback(async () => {
    const pending = callRef.current;
    const callerId = pending.peerId ?? pending.callerId;
    if (!pending.offer || !callerId) return;
    let pc: any = null;
    let localStream: any = null;
    try {
      if (!peerRef.current || peerRef.current.id !== callerId) {
        const nextPeer = await fetchPeerById(callerId);
        if (nextPeer) setPeer(nextPeer);
      }
      pc = createPeerConnection(iceServers);
      configurePeerConnection(pc, callerId);
      localStream = await getUserCallMedia(Boolean(pending.isVideo));
      localStream.getTracks().forEach((track: any) => pc.addTrack(track, localStream));
      await pc.setRemoteDescription(toSessionDescription(pending.offer));
      await flushPendingIceCandidates(pc, callerId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendCallSignal("call.answer", callerId, { answer: pc.localDescription ?? answer });
      setCallState({ status: "in-call", peerId: callerId, callerId, pc, localStream, isVideo: Boolean(pending.isVideo) });
    } catch {
      pc?.close();
      stopStreamTracks(localStream);
      setStatusForAWhile("Could not accept call. Check microphone/camera access.");
      endCall({ notifyPeer: true, peerId: callerId });
    }
  }, [configurePeerConnection, endCall, fetchPeerById, flushPendingIceCandidates, iceServers, sendCallSignal, setCallState, setStatusForAWhile]);

  const toggleMic = useCallback(() => {
    const current = callRef.current;
    const track = current.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCall((prev) => {
      const next = { ...prev, muted: !track.enabled };
      callRef.current = next;
      return next;
    });
  }, []);

  const toggleCamera = useCallback(async () => {
    const current = callRef.current;
    const pc: any = current.pc;
    const localStream: any = current.localStream;
    const targetId = getCallPeerId(current);
    if (!pc || !localStream || !targetId) return;
    const existingTrack = localStream.getVideoTracks()[0];
    if (existingTrack) {
      existingTrack.enabled = !existingTrack.enabled;
      setCall((prev) => {
        const next = { ...prev, cameraOff: !existingTrack.enabled, isVideo: true };
        callRef.current = next;
        return next;
      });
      return;
    }
    let camStream: any = null;
    try {
      camStream = await getUserCallMedia(true);
      const videoTrack = camStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("camera_missing");
      localStream.addTrack(videoTrack);
      pc.addTrack(videoTrack, localStream);
      await renegotiateCall(pc, targetId, true);
      setCall((prev) => {
        const next = { ...prev, localStream, isVideo: true, cameraOff: false };
        callRef.current = next;
        return next;
      });
    } catch {
      stopStreamTracks(camStream);
      setStatusForAWhile("Could not enable camera.");
    }
  }, [getCallPeerId, renegotiateCall, setStatusForAWhile]);

  const handleWsMessage = useCallback(async (event: { data: string }) => {
    try {
      const data = JSON.parse(event.data) as { type?: string; payload?: any };
      const { type, payload } = data;
      if (!type || !payload) return;

      if (type === "message.receive") {
        const currentUser = userRef.current;
        const currentKeys = keysRef.current;
        if (!currentUser) return;
        const currentPeer = peerRef.current;
        const message = decryptIncomingMessage(payload, currentUser.id, currentKeys, currentPeer, chatMode);
        if (currentPeer && (payload.from === currentPeer.id || payload.to === currentPeer.id)) {
          setMessages((prev) => [...prev, message]);
          if (payload.from === currentPeer.id && activeViewRef.current === "chat") sendReadReceipts(currentPeer.id, [message.id]);
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
        } else {
          setUnreadMap((prev) => ({ ...prev, [payload.from]: (prev[payload.from] ?? 0) + 1 }));
        }
        fetchChatsRef.current();
        return;
      }

      if (type === "message.delivered") {
        setMessages((prev) => prev.map((msg) => msg.id === payload.id ? { ...msg, status: "delivered" } : msg));
        return;
      }

      if (type === "message.read") {
        const ids = Array.isArray(payload.ids) ? payload.ids : [];
        setMessages((prev) => prev.map((msg) => ids.includes(msg.id) ? { ...msg, status: "read" } : msg));
        return;
      }

      if (type === "message.deleted") {
        setMessages((prev) => prev.filter((msg) => msg.id !== payload.id));
        fetchChatsRef.current();
        return;
      }

      if (type === "message.edited") {
        const currentUser = userRef.current;
        if (!currentUser) return;
        const edited = decryptIncomingMessage(payload, currentUser.id, keysRef.current, peerRef.current, chatMode);
        setMessages((prev) => prev.map((msg) => msg.id === edited.id ? edited : msg));
        return;
      }

      if (type === "message.pinned") {
        setMessages((prev) => prev.map((msg) => msg.id === payload.id ? { ...msg, pinned: Boolean(payload.pinned) } : msg));
        return;
      }

      if (type === "message.reacted") {
        setMessages((prev) => prev.map((msg) => msg.id === payload.id ? { ...msg, reactions: payload.reactions ?? {} } : msg));
        return;
      }

      if (type === "conversation.deleted") {
        if (peerRef.current?.id === payload.peerId) setMessages([]);
        fetchChatsRef.current();
        return;
      }

      if (type === "typing") {
        if (peerRef.current?.id === payload.from) {
          setPeerTyping(true);
          if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
          peerTypingTimerRef.current = setTimeout(() => setPeerTyping(false), 2200);
        }
        return;
      }

      if (type === "presence") {
        setOnlineUserIds((prev) => {
          const next = new Set(prev);
          if (payload.isOnline) next.add(payload.userId);
          else next.delete(payload.userId);
          return next;
        });
        return;
      }

      if (type === "call.offer") {
        const from = payload.from;
        const offer = payload.offer as SessionDescriptionInit | undefined;
        if (!from || !offer) return;
        if (payload.renegotiate) {
          await handleRenegotiateOffer(from, offer, Boolean(payload.isVideo));
          return;
        }
        if (callRef.current.status !== "idle") {
          sendCallSignal("call.end", from);
          return;
        }
        setCallState({ status: "incoming", peerId: from, callerId: from, offer, isVideo: Boolean(payload.isVideo) });
        return;
      }

      if (type === "call.answer") {
        const from = payload.from;
        const answer = payload.answer as SessionDescriptionInit | undefined;
        const current = callRef.current;
        const pc: any = current.pc;
        if (!from || !answer || !pc || current.peerId !== from) return;
        await pc.setRemoteDescription(toSessionDescription(answer));
        await flushPendingIceCandidates(pc, from);
        setCallState({ ...current, status: "in-call" });
        return;
      }

      if (type === "call.ice") {
        const from = payload.from;
        const candidate = payload.candidate as IceCandidateInit | undefined;
        if (from && candidate) await handleRemoteIceCandidate(from, candidate);
        return;
      }

      if (type === "call.end") {
        endCall({ notifyPeer: false, peerId: payload.from });
      }
    } catch {
      // malformed or stale event
    }
  }, [
    endCall,
    flushPendingIceCandidates,
    handleRemoteIceCandidate,
    handleRenegotiateOffer,
    sendCallSignal,
    sendReadReceipts,
    setCallState,
    chatMode,
  ]);

  useEffect(() => {
    if (!token) return;
    shouldReconnectRef.current = true;
    const connect = () => {
      if (!shouldReconnectRef.current) return;
      const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
      wsRef.current = socket;
      socket.onopen = () => {
        setStatusForAWhile("Connected.");
        fetchChatsRef.current();
      };
      socket.onmessage = (event) => { void handleWsMessage(event as any); };
      socket.onerror = () => setStatusForAWhile("WebSocket error.");
      socket.onclose = () => {
        if (wsRef.current === socket) wsRef.current = null;
        if (shouldReconnectRef.current) {
          reconnectTimerRef.current = setTimeout(connect, 2000);
        }
      };
    };
    connect();
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
    };
  }, [handleWsMessage, setStatusForAWhile, token, wsUrl]);

  const requestCode = useCallback(async () => {
    if (!canRequestCode) {
      setStatusForAWhile("Enter a phone number in international format.");
      return;
    }
    try {
      setStatusForAWhile("Sending code...");
      const res = await fetch(`${apiUrl}/auth/request`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatusForAWhile("Could not send code.");
        return;
      }
      setDevCode(data.devCode ?? "");
      setStatusForAWhile(data.devCode ? "Code sent (dev)." : "Code sent.");
    } catch {
      setStatusForAWhile("Network error.");
    }
  }, [apiUrl, canRequestCode, phone, setStatusForAWhile]);

  const verifyCode = useCallback(async () => {
    try {
      setStatusForAWhile("Signing in...");
      const res = await fetch(`${apiUrl}/auth/verify`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.token || !data.user) {
        setStatusForAWhile("Wrong code.");
        return;
      }
      await saveToken(data.token);
      setToken(data.token);
      setUser(data.user);
      setCode("");
      setDevCode("");
      setActiveView("chats");
      await configureChatForUser(apiUrl, data.token, data.user);
      setStatusForAWhile("Signed in.");
    } catch {
      setStatusForAWhile("Network error.");
    }
  }, [apiUrl, code, configureChatForUser, phone, setStatusForAWhile]);

  const logout = useCallback(async () => {
    endCall({ notifyPeer: true });
    await clearToken();
    setToken(null);
    setUser(null);
    setKeys(null);
    setPeer(null);
    setMessages([]);
    setChats([]);
    setPendingQr(null);
    setScannerOpen(false);
    setChatMode(DEFAULT_CHAT_MODE);
    setKeyStatus({ state: "blocked", reason: "Not signed in." });
    shouldReconnectRef.current = false;
    wsRef.current?.close();
    wsRef.current = null;
  }, [endCall]);

  const restoreKeys = useCallback(async () => {
    if (!token || restorePin.length < 8) {
      setStatusForAWhile("MAS PIN must contain at least 8 characters.");
      return;
    }
    try {
      const restored = await restoreAndStoreKeys(apiUrl, token, restorePin);
      setKeys(restored);
      setKeyStatus({ state: "ready" });
      setUser((prev) => prev ? { ...prev, publicKey: restored.publicKey } : prev);
      setRestorePin("");
      setStatusForAWhile("Key restored.");
      fetchChatsRef.current();
    } catch {
      setStatusForAWhile("Could not restore key. Check MAS PIN.");
    }
  }, [apiUrl, restorePin, setStatusForAWhile, token]);

  const saveBackup = useCallback(async () => {
    if (!token || !keys) {
      setStatusForAWhile("Keys are not ready.");
      return;
    }
    if (backupPin.length < 8) {
      setStatusForAWhile("MAS PIN must contain at least 8 characters.");
      return;
    }
    try {
      await saveKeyBackup(apiUrl, token, keys, backupPin);
      setBackupPin("");
      setStatusForAWhile("Key backup saved.");
    } catch {
      setStatusForAWhile("Could not save key backup.");
    }
  }, [apiUrl, backupPin, keys, setStatusForAWhile, token]);

  const resetLocalKeys = useCallback(async () => {
    await clearStoredKeys();
    setKeys(null);
    if (token && user) await configureChatForUser(apiUrl, token, user);
  }, [apiUrl, configureChatForUser, token, user]);

  const sendTyping = useCallback(() => {
    const socket = wsRef.current;
    const currentPeer = peerRef.current;
    if (!currentPeer || socket?.readyState !== WebSocket.OPEN || typingTimerRef.current) return;
    socket.send(JSON.stringify({ type: "typing", payload: { to: currentPeer.id } }));
    typingTimerRef.current = setTimeout(() => { typingTimerRef.current = null; }, 2000);
  }, []);

  const refreshPeerKey = useCallback(async (currentPeer: User) => {
    if (currentPeer.publicKey) return currentPeer;
    const refreshed = await fetchPeerById(currentPeer.id);
    if (refreshed?.publicKey) {
      setPeer(refreshed);
      return refreshed;
    }
    return currentPeer;
  }, [fetchPeerById]);

  const sendMessage = useCallback(async (
    contentType: UiMessage["contentType"],
    text = "",
    meta?: Record<string, string>,
    replyToId?: string
  ) => {
    const socket = wsRef.current;
    const currentPeer = peerRef.current;
    const currentUser = userRef.current;
    const currentKeys = keysRef.current;
    if (!currentPeer || !currentUser) {
      setStatusForAWhile("Choose a chat first.");
      return;
    }
    if (socket?.readyState !== WebSocket.OPEN) {
      setStatusForAWhile("No WebSocket connection.");
      return;
    }
    const id = randomId();
    if (chatMode === "cloud") {
      const payload = buildCloudMessagePayload(id, currentPeer.id, contentType, text, meta, replyToId);
      socket.send(JSON.stringify({ type: "message.send", payload }));
      setMessages((prev) => [
        ...prev,
        {
          id,
          from: currentUser.id,
          to: currentPeer.id,
          createdAt: payload.createdAt,
          contentType,
          text,
          meta,
          isMine: true,
          status: "sent",
          replyToId,
        },
      ]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
      fetchChatsRef.current();
      return;
    }
    if (!currentKeys) {
      setStatusForAWhile("Restore encryption keys first.");
      return;
    }
    const targetPeer = await refreshPeerKey(currentPeer);
    if (!targetPeer.publicKey) {
      setStatusForAWhile("Peer has no public key.");
      return;
    }
    const payload = buildEncryptedMessagePayload(
      id,
      targetPeer.id,
      contentType,
      text,
      currentKeys,
      targetPeer.publicKey,
      meta,
      replyToId
    );
    socket.send(JSON.stringify({ type: "message.send", payload }));
    setMessages((prev) => [
      ...prev,
      {
        id,
        from: currentUser.id,
        to: targetPeer.id,
        createdAt: payload.createdAt,
        contentType,
        text,
        meta,
        isMine: true,
        status: "sent",
        replyToId,
      },
    ]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    fetchChatsRef.current();
  }, [chatMode, refreshPeerKey, setStatusForAWhile]);

  const editMessage = useCallback(async (msg: UiMessage, newText: string) => {
    const socket = wsRef.current;
    const currentPeer = peerRef.current;
    const currentKeys = keysRef.current;
    if (!currentPeer || socket?.readyState !== WebSocket.OPEN) return;
    if (chatMode === "cloud") {
      socket.send(JSON.stringify({
        type: "message.edit",
        payload: { id: msg.id, peerId: currentPeer.id, body: newText },
      }));
      setMessages((prev) => prev.map((item) =>
        item.id === msg.id ? { ...item, text: newText, editedAt: new Date().toISOString() } : item
      ));
      setEditingMessage(null);
      setSelectedMessage(null);
      return;
    }
    if (!currentKeys) return;
    const targetPeer = await refreshPeerKey(currentPeer);
    if (!targetPeer.publicKey) return;
    const encrypted = buildEncryptedMessagePayload(
      msg.id,
      targetPeer.id,
      "text",
      newText,
      currentKeys,
      targetPeer.publicKey
    );
    socket.send(JSON.stringify({
      type: "message.edit",
      payload: {
        id: msg.id,
        peerId: targetPeer.id,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        selfNonce: encrypted.selfNonce,
        selfCiphertext: encrypted.selfCiphertext,
        senderPublicKey: encrypted.senderPublicKey,
      },
    }));
    setMessages((prev) => prev.map((item) =>
      item.id === msg.id ? { ...item, text: newText, editedAt: new Date().toISOString() } : item
    ));
    setEditingMessage(null);
    setSelectedMessage(null);
  }, [chatMode, refreshPeerKey]);

  const handleSendText = useCallback(async () => {
    const text = messageInput.trim();
    if (!text) return;
    if (editingMessage) await editMessage(editingMessage, text);
    else await sendMessage("text", text, undefined, replyTo?.id);
    setMessageInput("");
    setReplyTo(null);
  }, [editMessage, editingMessage, messageInput, replyTo, sendMessage]);

  const deleteMessage = useCallback((msg: UiMessage) => {
    const currentPeer = peerRef.current;
    const socket = wsRef.current;
    if (!currentPeer || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "message.delete", payload: { id: msg.id, peerId: currentPeer.id } }));
    setMessages((prev) => prev.filter((item) => item.id !== msg.id));
    setSelectedMessage(null);
  }, []);

  const pinMessage = useCallback((msg: UiMessage) => {
    const currentPeer = peerRef.current;
    const socket = wsRef.current;
    if (!currentPeer || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "message.pin", payload: { id: msg.id, peerId: currentPeer.id } }));
    setMessages((prev) => prev.map((item) => item.id === msg.id ? { ...item, pinned: !item.pinned } : item));
    setSelectedMessage(null);
  }, []);

  const reactToMessage = useCallback((msg: UiMessage, emoji: string) => {
    const currentPeer = peerRef.current;
    const currentUser = userRef.current;
    const socket = wsRef.current;
    if (!currentPeer || !currentUser || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "message.react", payload: { id: msg.id, peerId: currentPeer.id, emoji } }));
    setMessages((prev) => prev.map((item) => {
      if (item.id !== msg.id) return item;
      const reactions = { ...(item.reactions ?? {}) };
      const users = reactions[emoji] ? [...reactions[emoji]] : [];
      const index = users.indexOf(currentUser.id);
      if (index >= 0) users.splice(index, 1);
      else users.push(currentUser.id);
      if (users.length) reactions[emoji] = users;
      else delete reactions[emoji];
      return { ...item, reactions };
    }));
    setSelectedMessage(null);
  }, []);

  const copyMessage = useCallback(async (msg: UiMessage) => {
    await Clipboard.setStringAsync(msg.text ?? "");
    setSelectedMessage(null);
    setStatusForAWhile("Copied.");
  }, [setStatusForAWhile]);

  const attachFile = useCallback(async () => {
    const currentPeer = peerRef.current;
    const currentKeys = keysRef.current;
    if (!token || !currentPeer) return;
    try {
      const meta = chatMode === "cloud"
        ? await uploadCloudFile(apiUrl, token, currentPeer)
        : currentKeys
          ? await uploadEncryptedFile(apiUrl, token, currentPeer, currentKeys)
          : null;
      if (!meta) return;
      await sendMessage("file", "", meta, replyTo?.id);
      setReplyTo(null);
    } catch {
      setStatusForAWhile("File upload failed.");
    }
  }, [apiUrl, chatMode, replyTo, sendMessage, setStatusForAWhile, token]);

  const openFile = useCallback(async (msg: UiMessage) => {
    const currentKeys = keysRef.current;
    if (!token) return;
    try {
      if (chatMode === "cloud" || !msg.meta?.nonce) {
        await shareCloudFile(apiUrl, token, msg);
        return;
      }
      if (!currentKeys) {
        setStatusForAWhile("Restore encryption keys first.");
        return;
      }
      await decryptAndShareFile(apiUrl, token, msg, currentKeys, peerRef.current);
    } catch {
      setStatusForAWhile("Could not decrypt or open file.");
    }
  }, [apiUrl, chatMode, setStatusForAWhile, token]);

  const clearChat = useCallback(() => {
    const currentPeer = peerRef.current;
    if (!token || !currentPeer) return;
    Alert.alert("Clear chat", "Delete this conversation?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "For me",
        style: "destructive",
        onPress: async () => {
          const res = await fetch(`${apiUrl}/messages/${currentPeer.id}?scope=me`, {
            method: "DELETE",
            headers: authHeaders(token),
          });
          if (res.ok) setMessages([]);
          fetchChatsRef.current();
        },
      },
      {
        text: "For both",
        style: "destructive",
        onPress: async () => {
          const res = await fetch(`${apiUrl}/messages/${currentPeer.id}?scope=both`, {
            method: "DELETE",
            headers: authHeaders(token),
          });
          if (res.ok) setMessages([]);
          fetchChatsRef.current();
        },
      },
    ]);
  }, [apiUrl, token]);

  const openScanner = useCallback(async () => {
    setPendingQr(null);
    setScanned(false);
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setStatusForAWhile("Camera permission is required.");
        return;
      }
    }
    setScannerOpen(true);
  }, [permission?.granted, requestPermission, setStatusForAWhile]);

  const handleScanned = useCallback(({ data }: BarcodeScanningResult) => {
    if (scanned) return;
    setScanned(true);
    const parsed = parseQrPayload(data);
    if (!parsed) {
      setScannerOpen(false);
      setStatusForAWhile("This is not a MAS login QR.");
      return;
    }
    setPendingQr(parsed);
    setScannerOpen(false);
  }, [scanned, setStatusForAWhile]);

  const approveQr = useCallback(async () => {
    if (!token || !pendingQr) return;
    try {
      setStatusForAWhile("Approving login...");
      const res = await fetch(`${apiUrl}/auth/qr/approve`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(pendingQr),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        await expireSession();
        return;
      }
      if (!res.ok || data.status !== "approved") {
        setStatusForAWhile(data.status === "expired" ? "QR code expired." : "Could not approve QR login.");
        return;
      }
      setPendingQr(null);
      setStatusForAWhile("Login approved.");
      Alert.alert("MAS Secure", "Login approved.");
    } catch {
      setStatusForAWhile("Network error.");
    }
  }, [apiUrl, expireSession, pendingQr, setStatusForAWhile, token]);

  const renderServerUrlEditor = () => (
    <View style={styles.panel}>
      <Text style={styles.small}>Server URL</Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.inputGrow]}
          placeholder={SERVER_URL_PLACEHOLDER}
          placeholderTextColor="#64748b"
          value={serverUrlInput}
          onChangeText={setServerUrlInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Pressable style={styles.secondaryButton} onPress={() => { void saveServerUrl(); }}>
          <Text style={styles.secondaryText}>Save</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>Saved: {apiUrl}</Text>
    </View>
  );

  const renderAuth = () => (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.center}>
        <View style={styles.card}>
          <Text style={styles.title}>MAS Secure</Text>
          <Text style={styles.subtitle}>Sign in with your phone number. QR approval is available after mobile sign-in.</Text>
          {renderServerUrlEditor()}
          <TextInput
            style={styles.input}
            placeholder="+15555552671"
            placeholderTextColor="#64748b"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoCapitalize="none"
          />
          <Pressable
            style={[styles.button, !canRequestCode && styles.disabled]}
            onPress={requestCode}
            disabled={!canRequestCode}
          >
            <Text style={styles.buttonText}>Get code</Text>
          </Pressable>
          {devCode ? <Text style={styles.hint}>Dev code: {devCode}</Text> : null}
          <TextInput
            style={styles.input}
            placeholder="Code"
            placeholderTextColor="#64748b"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
          />
          <Pressable style={styles.button} onPress={verifyCode}>
            <Text style={styles.buttonText}>Sign in</Text>
          </Pressable>
        </View>
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </View>
    </SafeAreaView>
  );

  const filteredChats = useMemo(() => {
    const query = chatQuery.trim().toLowerCase();
    if (!query) return chats;
    return chats.filter((chat) =>
      (chat.peerLogin ?? "").toLowerCase().includes(query) ||
      chat.peerPhone.toLowerCase().includes(query)
    );
  }, [chatQuery, chats]);

  const visibleMessages = useMemo(() => messages.filter((message) => !isDecryptFailed(message)), [messages]);
  const hiddenDecryptFailedCount = messages.length - visibleMessages.length;

  const renderChats = () => (
    <ScrollView style={styles.list} contentContainerStyle={styles.scrollContent}>
      <TextInput
        style={styles.input}
        placeholder="Search chats or people"
        placeholderTextColor="#64748b"
        value={chatQuery}
        onChangeText={setChatQuery}
        autoCapitalize="none"
      />
      {searchResults.length > 0 && (
        <View style={styles.panel}>
          <Text style={styles.small}>People</Text>
          {searchResults.map((item) => (
            <Pressable key={item.id} style={styles.chatItem} onPress={() => { void openPeer(item); }}>
              <Text style={styles.chatName}>{displayName(item)}</Text>
              <Text style={styles.small}>{item.phone}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {chatsError ? (
        <View style={styles.panel}>
          <Text style={styles.subtitle}>{chatsError}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => { void fetchChats(); }}>
            <Text style={styles.secondaryText}>Refresh chats</Text>
          </Pressable>
        </View>
      ) : null}
      {filteredChats.map((chat) => (
        <Pressable key={chat.peerId} style={styles.chatItem} onPress={() => { void openChat(chat); }}>
          <View style={styles.spread}>
            <View style={styles.headerTitleWrap}>
              <View style={styles.row}>
                {onlineUserIds.has(chat.peerId) ? <View style={styles.onlineDot} /> : null}
                <Text style={styles.chatName}>{chat.peerLogin ?? chat.peerPhone}</Text>
              </View>
              <Text style={styles.small}>{messagePreview(chat.lastContentType)} · {formatTime(chat.lastMessageAt)}</Text>
            </View>
            {unreadMap[chat.peerId] ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadMap[chat.peerId]}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      ))}
      {!filteredChats.length && !searchResults.length && !chatsError ? (
        <View style={styles.panel}>
          <Text style={styles.subtitle}>No chats yet. Search a login or phone to start.</Text>
        </View>
      ) : null}
    </ScrollView>
  );

  const renderMessage = (msg: UiMessage) => {
    const selected = selectedMessage?.id === msg.id;
    const reactions = msg.reactions ? Object.entries(msg.reactions).filter(([, users]) => users.length) : [];
    return (
      <Pressable
        key={msg.id}
        style={[
          styles.bubble,
          msg.isMine ? styles.bubbleMine : styles.bubbleTheirs,
          selected && styles.bubbleSelected,
        ]}
        onPress={() => msg.contentType === "file" ? void openFile(msg) : setSelectedMessage(selected ? null : msg)}
        onLongPress={() => setSelectedMessage(msg)}
      >
        {msg.replyToId ? <Text style={styles.metaText}>Reply to {msg.replyToId.slice(0, 8)}</Text> : null}
        {msg.pinned ? <Text style={styles.hint}>Pinned</Text> : null}
        <Text style={styles.bubbleText}>
          {msg.contentType === "file" ? `File: ${msg.meta?.fileName ?? "download"}` : msg.text}
        </Text>
        {reactions.length ? (
          <Text style={styles.metaText}>
            {reactions.map(([emoji, users]) => `${emoji} ${users.length}`).join("  ")}
          </Text>
        ) : null}
        <Text style={styles.metaText}>
          {formatTime(msg.createdAt)}{msg.editedAt ? " · edited" : ""}{msg.status ? ` · ${msg.status}` : ""}
        </Text>
      </Pressable>
    );
  };

  const renderSelectedMessageActions = () => {
    if (!selectedMessage) return null;
    return (
      <View style={styles.actionBar}>
        <Text style={styles.small}>Message actions</Text>
        <View style={styles.actionGrid}>
          <Pressable style={styles.secondaryButton} onPress={() => { setReplyTo(selectedMessage); setSelectedMessage(null); }}>
            <Text style={styles.secondaryText}>Reply</Text>
          </Pressable>
          {selectedMessage.isMine && selectedMessage.contentType === "text" ? (
            <Pressable style={styles.secondaryButton} onPress={() => {
              setEditingMessage(selectedMessage);
              setMessageInput(selectedMessage.text ?? "");
              setSelectedMessage(null);
            }}>
              <Text style={styles.secondaryText}>Edit</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.secondaryButton} onPress={() => pinMessage(selectedMessage)}>
            <Text style={styles.secondaryText}>{selectedMessage.pinned ? "Unpin" : "Pin"}</Text>
          </Pressable>
          {selectedMessage.text ? (
            <Pressable style={styles.secondaryButton} onPress={() => { void copyMessage(selectedMessage); }}>
              <Text style={styles.secondaryText}>Copy</Text>
            </Pressable>
          ) : null}
          {selectedMessage.isMine ? (
            <Pressable style={[styles.secondaryButton, styles.dangerButton]} onPress={() => deleteMessage(selectedMessage)}>
              <Text style={styles.dangerText}>Delete</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.actionGrid}>
          {quickReactions.map((item) => (
            <Pressable key={item} style={styles.iconButton} onPress={() => reactToMessage(selectedMessage, item)}>
              <Text style={styles.secondaryText}>{item}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  };

  const renderChat = () => {
    if (!peer) {
      return (
        <View style={styles.center}>
          <Text style={styles.subtitle}>Choose a chat.</Text>
        </View>
      );
    }
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.logo}>{displayName(peer)}</Text>
            <Text style={styles.small}>{peerTyping ? "typing..." : onlineUserIds.has(peer.id) ? "online" : peer.phone}</Text>
          </View>
          <Pressable style={styles.iconButton} onPress={() => startCall(false)}>
            <Text style={styles.iconText}>Call</Text>
          </Pressable>
          <Pressable style={styles.iconButton} onPress={() => startCall(true)}>
            <Text style={styles.iconText}>Video</Text>
          </Pressable>
          <Pressable style={styles.iconButton} onPress={clearChat}>
            <Text style={styles.iconText}>Clear</Text>
          </Pressable>
        </View>
        <ScrollView
          ref={scrollRef}
          style={styles.messageList}
          contentContainerStyle={styles.messageContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {hiddenDecryptFailedCount > 0 ? (
            <View style={styles.actionBar}>
              <Text style={styles.small}>{hiddenDecryptFailedCount} old message(s) cannot be decrypted on this device.</Text>
            </View>
          ) : null}
          {visibleMessages.map(renderMessage)}
        </ScrollView>
        {renderSelectedMessageActions()}
        {(replyTo || editingMessage) ? (
          <View style={styles.actionBar}>
            <View style={styles.spread}>
              <Text style={styles.small}>{editingMessage ? "Editing message" : `Replying to: ${replyTo?.text ?? replyTo?.meta?.fileName ?? "message"}`}</Text>
              <Pressable onPress={() => { setReplyTo(null); setEditingMessage(null); setMessageInput(""); }}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <View style={styles.composer}>
          <View style={styles.row}>
            <Pressable style={styles.iconButton} onPress={() => { void attachFile(); }}>
              <Text style={styles.iconText}>+</Text>
            </Pressable>
            <TextInput
              style={[styles.input, styles.inputGrow, styles.multilineInput]}
              placeholder="Message"
              placeholderTextColor="#64748b"
              value={messageInput}
              onChangeText={(value) => {
                setMessageInput(value);
                sendTyping();
              }}
              multiline
            />
            <Pressable style={styles.button} onPress={() => { void handleSendText(); }}>
              <Text style={styles.buttonText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  };

  const renderQr = () => (
    <ScrollView style={styles.list} contentContainerStyle={styles.scrollContent}>
      <View style={styles.card}>
        <Text style={styles.title}>Approve QR login</Text>
        <Text style={styles.subtitle}>Scan QR from web or desktop. Approval uses the saved Server URL.</Text>
        {renderServerUrlEditor()}
        {scannerOpen ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={handleScanned}
          />
        ) : pendingQr ? (
          <View style={styles.card}>
            <Text style={styles.subtitle}>Approve this web or desktop login?</Text>
            <Pressable style={styles.button} onPress={() => { void approveQr(); }}>
              <Text style={styles.buttonText}>Approve login</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={() => setPendingQr(null)}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.button} onPress={() => { void openScanner(); }}>
            <Text style={styles.buttonText}>Scan QR</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );

  const renderSettings = () => (
    <ScrollView style={styles.list} contentContainerStyle={styles.scrollContent}>
      <View style={styles.card}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>{displayName(user)} · {user?.phone}</Text>
        {renderServerUrlEditor()}
      </View>
      <View style={styles.card}>
        <Text style={styles.title}>{chatMode === "cloud" ? "Cloud messages" : "Encryption keys"}</Text>
        <Text style={styles.subtitle}>
          {chatMode === "cloud" ? "Messages are available after sign in. MAS PIN is not required for normal chats." :
            keyStatus.state === "ready" ? "Ready" :
              keyStatus.state === "checking" ? "Checking..." :
                keyStatus.state === "restore-required" ? "Restore required" :
                  keyStatus.reason}
        </Text>
        {chatMode !== "cloud" && keyStatus.state === "restore-required" ? (
          <>
            <Text style={styles.small}>
              {keyStatus.backupAvailable
                ? "This account already has a desktop/web key. Enter MAS PIN to restore it."
                : "This account already has a key, but no backup exists on the server."}
            </Text>
            <TextInput
              style={styles.input}
              placeholder="MAS PIN"
              placeholderTextColor="#64748b"
              value={restorePin}
              onChangeText={setRestorePin}
              secureTextEntry
            />
            <Pressable
              style={[styles.button, !keyStatus.backupAvailable && styles.disabled]}
              onPress={() => { void restoreKeys(); }}
              disabled={!keyStatus.backupAvailable}
            >
              <Text style={styles.buttonText}>Restore key</Text>
            </Pressable>
          </>
        ) : null}
        {chatMode !== "cloud" && keys ? (
          <>
            <TextInput
              style={styles.input}
              placeholder="New MAS PIN for backup"
              placeholderTextColor="#64748b"
              value={backupPin}
              onChangeText={setBackupPin}
              secureTextEntry
            />
            <Pressable style={styles.button} onPress={() => { void saveBackup(); }}>
              <Text style={styles.buttonText}>Save key backup</Text>
            </Pressable>
          </>
        ) : null}
        {chatMode !== "cloud" ? (
          <Pressable style={styles.secondaryButton} onPress={() => { void resetLocalKeys(); }}>
            <Text style={styles.secondaryText}>Reload local keys</Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable style={[styles.secondaryButton, styles.dangerButton]} onPress={() => { void logout(); }}>
        <Text style={styles.dangerText}>Log out</Text>
      </Pressable>
    </ScrollView>
  );

  const renderCallOverlay = () => {
    if (call.status === "idle") return null;
    const currentPeer = peer?.id === getCallPeerId(call) ? peer : undefined;
    const callName = displayName(currentPeer) === "Contact" ? "Subscriber" : displayName(currentPeer);
    const remoteUrl = call.remoteStream ? (call.remoteStream as any).toURL?.() : undefined;
    const localUrl = call.localStream ? (call.localStream as any).toURL?.() : undefined;
    const showVideo = Boolean(call.isVideo && remoteUrl);
    return (
      <View style={styles.callOverlay}>
        {showVideo ? <RTCView style={styles.remoteVideo} streamURL={remoteUrl} objectFit="cover" /> : (
          <View style={styles.callCenter}>
            <View style={styles.callAvatar}>
              <Text style={styles.callAvatarText}>{callName.slice(0, 1).toUpperCase()}</Text>
            </View>
            <Text style={styles.title}>{callName}</Text>
            <Text style={styles.subtitle}>
              {call.status === "incoming" ? "Incoming call" : call.status === "calling" ? "Calling..." : "Call active"}
            </Text>
          </View>
        )}
        <View style={styles.callTop}>
          <Text style={styles.logo}>{call.isVideo ? "Video call" : "Audio call"}</Text>
          <Text style={styles.subtitle}>{callName}</Text>
        </View>
        {call.isVideo && localUrl ? (
          <RTCView style={styles.localVideo} streamURL={localUrl} objectFit="cover" mirror />
        ) : null}
        <View style={styles.callControls}>
          {call.status === "incoming" ? (
            <>
              <Pressable style={[styles.callControl, styles.callControlActive]} onPress={() => { void acceptCall(); }}>
                <Text style={styles.callControlText}>Accept</Text>
              </Pressable>
              <Pressable style={[styles.callControl, styles.callEnd]} onPress={() => endCall({ notifyPeer: true })}>
                <Text style={styles.callControlText}>Decline</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable style={[styles.callControl, call.muted && styles.callControlActive]} onPress={toggleMic}>
                <Text style={styles.callControlText}>{call.muted ? "Unmute" : "Mute"}</Text>
              </Pressable>
              <Pressable style={[styles.callControl, call.cameraOff && styles.callControlActive]} onPress={() => { void toggleCamera(); }}>
                <Text style={styles.callControlText}>{call.cameraOff ? "Cam on" : "Camera"}</Text>
              </Pressable>
              <Pressable style={[styles.callControl, styles.callEnd]} onPress={() => endCall({ notifyPeer: true })}>
                <Text style={styles.callControlText}>End</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    );
  };

  const renderBody = () => {
    if (activeView === "chat") return renderChat();
    if (activeView === "qr") return renderQr();
    if (activeView === "settings") return renderSettings();
    return renderChats();
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <View style={styles.center}>
          <ActivityIndicator color={colors.cyan} />
        </View>
      </SafeAreaView>
    );
  }

  if (!signedIn) return renderAuth();

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      {activeView !== "chat" ? (
        <View style={styles.header}>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.logo}>MAS Secure</Text>
            <Text style={styles.small}>{displayName(user)}</Text>
          </View>
          <Pressable onPress={() => { void fetchChats(); }}>
            <Text style={styles.link}>Refresh</Text>
          </Pressable>
        </View>
      ) : null}
      {renderBody()}
      {status ? <Text style={styles.status}>{status}</Text> : null}
      <View style={styles.tabBar}>
        {([
          ["chats", "Chats"],
          ["qr", "QR"],
          ["settings", "Settings"],
        ] as Array<[ViewName, string]>).map(([name, label]) => (
          <Pressable
            key={name}
            style={[styles.tab, activeView === name && styles.tabActive]}
            onPress={() => setActiveView(name)}
          >
            <Text style={[styles.tabText, activeView === name && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {renderCallOverlay()}
    </SafeAreaView>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import * as SecureStore from "expo-secure-store";

type User = {
  id: string;
  phone: string;
  login?: string;
};

type QrPayload = {
  qrSessionId: string;
  secret: string;
};

const DEFAULT_API_URL = "http://10.1.1.132:4000";
const TOKEN_KEY = "mas.mobile.token";
const API_URL_KEY = "mas.mobile.apiUrl";

const parseQrPayload = (value: string): QrPayload | null => {
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

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [loading, setLoading] = useState(true);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [status, setStatus] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [pendingQr, setPendingQr] = useState<QrPayload | null>(null);

  const signedIn = Boolean(token && user);
  const canRequestCode = useMemo(() => phone.trim().length >= 5, [phone]);

  useEffect(() => {
    (async () => {
      const savedApiUrl = await SecureStore.getItemAsync(API_URL_KEY);
      const nextApiUrl = savedApiUrl || DEFAULT_API_URL;
      setApiUrl(nextApiUrl);
      const saved = await SecureStore.getItemAsync(TOKEN_KEY);
      if (!saved) {
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`${nextApiUrl}/users/me`, {
          headers: { Authorization: `Bearer ${saved}` }
        });
        if (!res.ok) throw new Error("unauthorized");
        setToken(saved);
        setUser(await res.json());
      } catch {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveApiUrl = async (value: string) => {
    const normalized = value.trim().replace(/\/+$/, "");
    setApiUrl(normalized);
    await SecureStore.setItemAsync(API_URL_KEY, normalized);
    setStatus("Server URL saved.");
  };

  const requestCode = async () => {
    if (!canRequestCode) {
      setStatus("Enter a phone number in international format.");
      return;
    }
    try {
      setStatus("Sending code...");
      const res = await fetch(`${apiUrl}/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() })
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("Could not send code.");
        return;
      }
      setDevCode(data.devCode ?? "");
      setStatus(data.devCode ? "Code sent (dev)." : "Code sent.");
    } catch {
      setStatus("Network error.");
    }
  };

  const verifyCode = async () => {
    try {
      setStatus("Signing in...");
      const res = await fetch(`${apiUrl}/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() })
      });
      const data = await res.json();
      if (!res.ok || !data.token || !data.user) {
        setStatus("Wrong code.");
        return;
      }
      await SecureStore.setItemAsync(TOKEN_KEY, data.token);
      setToken(data.token);
      setUser(data.user);
      setStatus("");
      setCode("");
      setDevCode("");
    } catch {
      setStatus("Network error.");
    }
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setPendingQr(null);
    setScannerOpen(false);
    setStatus("");
  };

  const openScanner = async () => {
    setPendingQr(null);
    setScanned(false);
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setStatus("Camera permission is required.");
        return;
      }
    }
    setScannerOpen(true);
  };

  const handleScanned = ({ data }: BarcodeScanningResult) => {
    if (scanned) return;
    setScanned(true);
    const parsed = parseQrPayload(data);
    if (!parsed) {
      setStatus("This is not a MAS login QR.");
      setScannerOpen(false);
      return;
    }
    setPendingQr(parsed);
    setScannerOpen(false);
    setStatus("");
  };

  const approveQr = async () => {
    if (!token || !pendingQr) return;
    try {
      setStatus("Approving login...");
      const res = await fetch(`${apiUrl}/auth/qr/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(pendingQr)
      });
      const data = await res.json();
      if (!res.ok || data.status !== "approved") {
        setStatus(data.status === "expired" ? "QR code expired." : "Could not approve QR login.");
        return;
      }
      setPendingQr(null);
      setStatus("Login approved.");
      Alert.alert("MAS Secure", "Login approved.");
    } catch {
      setStatus("Network error.");
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color="#22d3ee" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.logo}>MAS Secure</Text>
        {signedIn && <Pressable onPress={logout}><Text style={styles.link}>Log out</Text></Pressable>}
      </View>

      {!signedIn ? (
        <View style={styles.card}>
          <Text style={styles.title}>Sign in on mobile</Text>
          <Text style={styles.subtitle}>Use a phone number first. QR login is only for approving web and desktop sessions.</Text>
          <Text style={styles.label}>Server URL</Text>
          <TextInput style={styles.input} placeholder="http://10.1.1.132:4000" placeholderTextColor="#64748b"
            value={apiUrl} onChangeText={setApiUrl} autoCapitalize="none" autoCorrect={false}
            onEndEditing={() => saveApiUrl(apiUrl)} />
          <TextInput style={styles.input} placeholder="+15555552671" placeholderTextColor="#64748b"
            value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoCapitalize="none" />
          <Pressable style={[styles.button, !canRequestCode && styles.buttonDisabled]} onPress={requestCode} disabled={!canRequestCode}>
            <Text style={styles.buttonText}>Get code</Text>
          </Pressable>
          {devCode ? <Text style={styles.hint}>Dev code: {devCode}</Text> : null}
          <TextInput style={styles.input} placeholder="Code" placeholderTextColor="#64748b"
            value={code} onChangeText={setCode} keyboardType="number-pad" />
          <Pressable style={styles.button} onPress={verifyCode}>
            <Text style={styles.buttonText}>Sign in</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.title}>Approve QR login</Text>
          <Text style={styles.subtitle}>{user?.login ?? user?.phone}</Text>
          <Text style={styles.label}>Server: {apiUrl}</Text>
          {scannerOpen ? (
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={handleScanned}
            />
          ) : pendingQr ? (
            <View style={styles.confirmBox}>
              <Text style={styles.subtitle}>Approve this web or desktop login?</Text>
              <Pressable style={styles.button} onPress={approveQr}>
                <Text style={styles.buttonText}>Approve login</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setPendingQr(null)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={styles.button} onPress={openScanner}>
              <Text style={styles.buttonText}>Scan QR</Text>
            </Pressable>
          )}
        </View>
      )}

      {status ? <Text style={styles.status}>{status}</Text> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: "#0b1020",
    padding: 20
  },
  header: {
    position: "absolute",
    top: 54,
    left: 20,
    right: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  logo: {
    fontSize: 22,
    fontWeight: "700",
    color: "#f8fafc"
  },
  link: {
    color: "#22d3ee",
    fontWeight: "700"
  },
  card: {
    gap: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.05)",
    padding: 18
  },
  title: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "700"
  },
  subtitle: {
    color: "rgba(248,250,252,0.7)",
    lineHeight: 20
  },
  label: {
    color: "#a5f3fc",
    fontSize: 12,
    fontWeight: "700"
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 12,
    backgroundColor: "#0f172a",
    color: "#f8fafc",
    paddingHorizontal: 14
  },
  button: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "#22d3ee"
  },
  buttonDisabled: {
    opacity: 0.45
  },
  buttonText: {
    color: "#0b1020",
    fontWeight: "800"
  },
  secondaryButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)"
  },
  secondaryText: {
    color: "#f8fafc",
    fontWeight: "700"
  },
  hint: {
    color: "#22d3ee",
    fontSize: 12
  },
  status: {
    marginTop: 14,
    color: "#a5f3fc",
    textAlign: "center"
  },
  camera: {
    height: 320,
    overflow: "hidden",
    borderRadius: 16
  },
  confirmBox: {
    gap: 12
  }
});

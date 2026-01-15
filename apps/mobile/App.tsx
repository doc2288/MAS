import { SafeAreaView, StatusBar, StyleSheet, Text, View } from "react-native";

const tags = ["React", "TypeScript", "E2E", "Hot Reload"];

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.logo}>MAS</Text>
        <Text style={styles.tag}>Mobile Secure</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Захищені чати завжди під рукою</Text>
        <Text style={styles.subtitle}>
          Швидкі оновлення у dev-режимі та готовність до синхронізації з десктопом.
        </Text>
        <View style={styles.tagRow}>
          {tags.map((item) => (
            <View style={styles.tagPill} key={item}>
              <Text style={styles.tagText}>{item}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.chat}>
        <View style={[styles.bubble, styles.incoming]}>
          <Text style={styles.bubbleText}>Сесія зашифрована ✅</Text>
        </View>
        <View style={[styles.bubble, styles.outgoing]}>
          <Text style={styles.bubbleText}>Перевіряю оновлення перед релізом.</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b1020",
    paddingHorizontal: 20,
    paddingTop: 12
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24
  },
  logo: {
    fontSize: 22,
    fontWeight: "700",
    color: "#f5f7ff"
  },
  tag: {
    fontSize: 12,
    color: "#93c5fd",
    backgroundColor: "rgba(59, 130, 246, 0.2)",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999
  },
  card: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderRadius: 20,
    padding: 18,
    marginBottom: 24
  },
  title: {
    fontSize: 20,
    color: "#f5f7ff",
    fontWeight: "600",
    marginBottom: 8
  },
  subtitle: {
    color: "rgba(245,247,255,0.7)",
    marginBottom: 16
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  tagPill: {
    backgroundColor: "rgba(34, 211, 238, 0.18)",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  tagText: {
    fontSize: 12,
    color: "#a5f3fc"
  },
  chat: {
    gap: 10
  },
  bubble: {
    padding: 12,
    borderRadius: 16,
    maxWidth: "80%"
  },
  incoming: {
    backgroundColor: "rgba(255,255,255,0.08)",
    alignSelf: "flex-start"
  },
  outgoing: {
    backgroundColor: "rgba(99, 102, 241, 0.35)",
    alignSelf: "flex-end"
  },
  bubbleText: {
    color: "#f5f7ff"
  }
});

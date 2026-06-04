export type ChatMode = "cloud" | "legacy";

export const CHAT_MODE: ChatMode = process.env.CHAT_MODE === "legacy" ? "legacy" : "cloud";

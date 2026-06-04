import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, mediaDevices } from "react-native-webrtc";
import type { IceCandidateInit, IceServer, SessionDescriptionInit } from "./types";

export const stopStreamTracks = (stream?: { getTracks(): Array<{ stop(): void; enabled?: boolean; onended?: (() => void) | null }> } | null) => {
  stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
};

export const createPeerConnection = (iceServers: IceServer[]) =>
  new RTCPeerConnection({ iceServers } as any);

export const getUserCallMedia = (isVideo: boolean) =>
  mediaDevices.getUserMedia({
    audio: true,
    video: isVideo ? { facingMode: "user" } : false,
  } as any);

export const toSessionDescription = (description: SessionDescriptionInit) =>
  new RTCSessionDescription(description as any);

export const toIceCandidate = (candidate: IceCandidateInit) =>
  new RTCIceCandidate(candidate as any);

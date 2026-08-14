import type { DeviceType } from "./coordinatorClient";

const DEVICE_ID_KEY = "cbc-lan-share:deviceId";
const NICKNAME_KEY = "cbc-lan-share:nickname";

function detectDeviceType(): DeviceType {
  const ua = navigator.userAgent;
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  return isMobile ? "phone" : "laptop";
}

function defaultNickname(): string {
  const type = detectDeviceType();
  const platform = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    ? "iPhone"
    : /Android/i.test(navigator.userAgent)
      ? "Android"
      : "Laptop";
  return `${platform} ${type === "phone" ? "device" : "device"}`;
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getNickname(): string {
  return localStorage.getItem(NICKNAME_KEY) ?? defaultNickname();
}

export function setNickname(nickname: string): void {
  localStorage.setItem(NICKNAME_KEY, nickname);
}

export function getDeviceType(): DeviceType {
  return detectDeviceType();
}

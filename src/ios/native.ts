// Verbindung zur iPad-Hülle (ADR 0029, ios/Blattwerk/Bridge.swift). Kleine Werte gehen als Nachricht hin und als
// Antwort zurück, Bytes über fetch an app://bundle/__native/… (der Schema-Handler der Hülle liest den Rumpf direkt).
// Ereignisse der Hülle (geöffnete Dateien, Menübefehle) kommen über window.__blattwerkNative.emit.

interface ReplyHandler {
  postMessage(message: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { blattwerk?: ReplyHandler } };
    __blattwerkNative?: { emit(event: string, payload: unknown): void };
  }
}

export const NATIVE_BASE = 'app://bundle/__native';

function handler(): ReplyHandler {
  const found = window.webkit?.messageHandlers?.blattwerk;
  if (!found) throw new Error('native-bridge-missing');
  return found;
}

// Aufruf eines Bausteins der Hülle; Fehler der Hülle kommen als abgelehntes Promise mit Kurztext
export async function call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await handler().postMessage({ method, args })) as T;
}

// Bytes holen (null bei 404)
export async function fetchBytes(path: string): Promise<Uint8Array | null> {
  const response = await fetch(`${NATIVE_BASE}/${path}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`native-fetch-${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Größe eines Stücks über die Brücke (als Base64 etwa ein Drittel mehr)
const UPLOAD_CHUNK = 4 * 1024 * 1024;

// Bytes an die Hülle geben; Antwort als JSON. Die Bytes gehen stückweise über die Brücke (auf dem Gerät reicht WebKit
// den Rumpf von fetch nicht an die Hülle weiter), die Anfrage selbst trägt nur Kennung und Länge. Die Hülle schreibt
// nur, wenn genau so viele Bytes angekommen sind.
export async function sendBytes<T>(path: string, bytes: Uint8Array, method: 'PUT' | 'POST' = 'PUT'): Promise<T> {
  const id = crypto.randomUUID();
  try {
    for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK) {
      await call('upload.chunk', { id, data: bytesToBase64(bytes.subarray(offset, offset + UPLOAD_CHUNK)) });
    }
  } catch (error) {
    void call('upload.discard', { id }).catch(() => undefined);
    throw error;
  }
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${NATIVE_BASE}/${path}${separator}upload=${id}&len=${bytes.length}`, { method });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `native-send-${response.status}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
// Ereignisse, die eintreffen, bevor jemand zuhört (z. B. eine Datei, mit der die App gestartet wurde)
const early = new Map<string, unknown[]>();

window.__blattwerkNative = {
  emit(event, payload) {
    const set = listeners.get(event);
    if (set && set.size > 0) for (const listener of set) listener(payload);
    else early.set(event, [...(early.get(event) ?? []), payload]);
  },
};

export function on(event: string, listener: Listener): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener);
  const waiting = early.get(event);
  if (waiting) {
    early.delete(event);
    for (const payload of waiting) queueMicrotask(() => listener(payload));
  }
  return () => {
    set.delete(listener);
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

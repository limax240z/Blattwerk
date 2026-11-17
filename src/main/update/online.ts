// Neue Version aus dem Netz holen (ADR 0027). CI stellt jede Version als Release in ein öffentliches GitHub-Projekt
// (UPDATE_REPOSITORY). Die App fragt dort nach der neuesten Version, lädt die passende Datei in den eigenen
// Update-Ordner und überlässt den Rest dem Updater aus ADR 0025 (Prüfen der Signatur, Austausch beim Beenden).
// Nur der Hauptprozess spricht mit dem Netz, nur mit GitHub und nur dafür; der Renderer bleibt ohne Netz.
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { APP_ID, PRODUCT_NAME, UPDATE_REPOSITORY } from '../../shared/product';
import {
  compareVersions,
  isAllowedUpdateUrl,
  parseRelease,
  updateAssetName,
  type OnlineCheck,
  type Release,
  type UpdateProgress,
} from '../../shared/update';
import { bundleInfo, checkForUpdate, defaultUpdateFolder, UPDATE_APP_NAME } from './updater';

const LATEST_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
// Größer ist keine echte Version von Blattwerk (die App ist etwa 150 MB groß)
const MAX_DOWNLOAD = 800 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Folgt Weiterleitungen selbst, damit jede Station geprüft wird (nur HTTPS, nur GitHub)
export async function fetchChecked(url: string, init: RequestInit, fetchImpl: FetchLike = fetch): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUpdateUrl(current)) throw new Error(`Adresse nicht erlaubt: ${current}`);
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current).href;
  }
  throw new Error('Zu viele Weiterleitungen');
}

const headers = (): Record<string, string> => ({ 'User-Agent': `${PRODUCT_NAME}/${app.getVersion()}`, Accept: 'application/vnd.github+json' });

// Letzte Antwort mit ihrem ETag: Die App fragt alle paar Minuten. Bedingte Anfragen (If-None-Match) beantwortet GitHub
// ohne Änderung mit 304 und ohne Inhalt. Ohne Anmeldung zählen auch sie gegen die Grenze von 60 Anfragen je Stunde
// (gemessen 2026-11-17); den Abstand regelt deshalb schedule.ts.
let cached: { etag: string; release: Release | null } | null = null;

export async function latestRelease(fetchImpl: FetchLike = fetch, baseHeaders: Record<string, string> = headers()): Promise<Release | null> {
  const conditional = cached ? { 'If-None-Match': cached.etag } : {};
  const response = await fetchChecked(LATEST_URL, { headers: { ...baseHeaders, ...conditional }, signal: AbortSignal.timeout(20_000) }, fetchImpl);
  if (response.status === 304 && cached) return cached.release;
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub antwortet mit ${response.status}`);
  const release = parseRelease(await response.json());
  const etag = response.headers.get('etag');
  cached = etag ? { etag, release } : null;
  return release;
}

// Nur für Tests: gemerkte Antwort vergessen
export function forgetLatestRelease(): void {
  cached = null;
}

// Lädt eine Datei in kleinen Stücken auf die Platte und meldet den Fortschritt
async function download(url: string, target: string, expected: number, onProgress: (received: number, total: number | null) => void): Promise<void> {
  const response = await fetchChecked(url, { headers: { 'User-Agent': headers()['User-Agent']!, Accept: 'application/octet-stream' } });
  if (!response.ok || !response.body) throw new Error(`Laden fehlgeschlagen (${response.status})`);
  const length = Number(response.headers.get('content-length')) || expected || null;
  if (length !== null && length > MAX_DOWNLOAD) throw new Error('Datei zu groß');
  let received = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_DOWNLOAD) body.destroy(new Error('Datei zu groß'));
    const now = Date.now();
    if (now - lastReport > 150) {
      lastReport = now;
      onProgress(received, length);
    }
  });
  await pipeline(body, createWriteStream(target));
  if (expected > 0 && received !== expected) throw new Error('Datei unvollständig');
  onProgress(received, length);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} endete mit ${code}`))));
  });
}

// macOS: App aus dem Archiv holen (ditto erhält Signatur und symbolische Verweise) und als Blattwerk.app in den
// Update-Ordner legen. Geprüft wird hier nur App-ID und Version; die Signatur prüft der Updater vor dem Anbieten.
async function installMacArchive(archive: string, folder: string, version: string): Promise<boolean> {
  const staging = await mkdtemp(path.join(folder, '.entpacken-'));
  try {
    await run('/usr/bin/ditto', ['-x', '-k', archive, staging]);
    const name = (await readdir(staging)).find((entry) => entry.endsWith('.app'));
    const bundle = name ? path.join(staging, name) : null;
    const info = bundle ? bundleInfo(bundle) : null;
    if (!bundle || info?.id !== APP_ID || info.version !== version) return false;
    const target = path.join(folder, UPDATE_APP_NAME);
    await rm(target, { recursive: true, force: true });
    await rename(bundle, target);
    return true;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Liegt diese Version schon im eigenen Update-Ordner?
function alreadyDownloaded(folder: string, version: string, assetName: string): boolean {
  if (process.platform === 'darwin') return bundleInfo(path.join(folder, UPDATE_APP_NAME))?.version === version;
  return existsSync(path.join(folder, assetName));
}

let running: Promise<OnlineCheck> | null = null;

// „Nach Updates suchen“ (und einmal beim Start): neueste Version erfragen und, wenn sie neuer ist, laden
export function checkOnline(onProgress: (progress: UpdateProgress) => void): Promise<OnlineCheck> {
  running ??= (async (): Promise<OnlineCheck> => {
    const local = checkForUpdate();
    if (local.state === 'unsupported') return local;
    let release: Release | null;
    try {
      release = await latestRelease();
    } catch {
      return { state: 'failed', reason: 'offline' };
    }
    if (!release) return { state: 'failed', reason: 'no-release' };
    const current = app.getVersion();
    if (compareVersions(release.version, current) <= 0) return { state: 'current', current };
    const assetName = updateAssetName(PRODUCT_NAME, release.version, process.platform, process.arch);
    const asset = release.assets.find((candidate) => candidate.name === assetName);
    if (!assetName || !asset) return { state: 'failed', reason: 'no-release' };
    const folder = defaultUpdateFolder();
    await mkdir(folder, { recursive: true });
    if (alreadyDownloaded(folder, release.version, assetName)) return { state: 'downloaded', version: release.version };

    const partial = path.join(folder, `.${assetName}.part`);
    const version = release.version;
    try {
      onProgress({ version, received: 0, total: asset.size || null });
      await download(asset.url, partial, asset.size, (received, total) => onProgress({ version, received, total }));
      if (process.platform === 'darwin') {
        if (!(await installMacArchive(partial, folder, version))) return { state: 'failed', reason: 'invalid' };
      } else {
        await rename(partial, path.join(folder, assetName));
      }
    } catch {
      return { state: 'failed', reason: 'download' };
    } finally {
      await rm(partial, { force: true });
    }
    return { state: 'downloaded', version };
  })().finally(() => {
    running = null;
  });
  return running;
}

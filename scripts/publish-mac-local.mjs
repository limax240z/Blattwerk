// Baut die Mac-Pakete (Apple Silicon und Intel) auf diesem Mac und lädt sie in das Release der aktuellen Version im
// Download-Projekt (ADR 0027). Ersatz für den Mac-Teil der CI, solange GitHub dem Konto keine Mac-Rechner gibt
// (Variable MAC_IN_CI = false). Vorher `npm run build`. Braucht die GitHub-CLI `gh`, angemeldet beim Konto des Projekts.
// Gibt es das Release noch nicht, wird es angelegt; die Windows-Datei ergänzt dann der CI-Job „Veröffentlichen“.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const repository = /UPDATE_REPOSITORY = '([^']+)'/.exec(readFileSync(path.join(root, 'src/shared/product.ts'), 'utf8'))?.[1];
if (!repository) throw new Error('UPDATE_REPOSITORY nicht gefunden');
const tag = `v${version}`;
const UPLOAD_ATTEMPTS = 4;

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if ((branch !== 'main' || dirty) && !process.argv.includes('--force')) {
  console.error(`Nur vom sauberen Zweig main veröffentlichen (jetzt: ${branch}${dirty ? ', mit Änderungen' : ''}). Sonst --force.`);
  process.exit(1);
}

// Im temporären Ordner bauen (wie dist-mac-local.mjs): dort setzt niemand Dateiattribute, an denen codesign scheitert
const outDir = mkdtempSync(path.join(tmpdir(), 'blattwerk-publish-'));
try {
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--mac', '--arm64', '--x64', '--publish', 'never', `--config.directories.output=${outDir}`],
    { cwd: root, stdio: 'inherit' },
  );

  // Dieselben Prüfungen wie in der CI: Signatur der App und nach dem Entpacken wie im Updater
  for (const dir of readdirSync(outDir).filter((name) => name.startsWith('mac'))) {
    execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(outDir, dir, 'Blattwerk.app')], { stdio: 'inherit' });
  }
  const files = readdirSync(outDir).filter((name) => name.endsWith('.dmg') || name.endsWith('-mac.zip'));
  for (const zip of files.filter((name) => name.endsWith('-mac.zip'))) {
    const unpacked = mkdtempSync(path.join(tmpdir(), 'blattwerk-zip-'));
    execFileSync('ditto', ['-x', '-k', path.join(outDir, zip), unpacked]);
    execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(unpacked, 'Blattwerk.app')], { stdio: 'inherit' });
    rmSync(unpacked, { recursive: true, force: true });
  }
  if (files.length !== 4) throw new Error(`Erwartet 4 Mac-Dateien, gefunden: ${files.join(', ')}`);

  const gh = (args) => execFileSync('gh', [...args, '--repo', repository], { stdio: 'inherit' });
  const assets = () => {
    try {
      return execFileSync('gh', ['release', 'view', tag, '--repo', repository, '--json', 'assets', '--jq', '.assets[].name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .filter(Boolean);
    } catch {
      return null;
    }
  };
  if (assets() === null) {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    gh(['release', 'create', tag, '--draft', '--title', `Blattwerk ${version}`, '--notes', `Automatisch gebaut aus ${sha}. Updates lädt Blattwerk über „Nach Updates suchen …“ selbst.`]);
  }
  // Einzeln und mit Wiederholung: GitHub bricht große Uploads gern mit HTTP 408 ab, und mehrere zugleich gehen öfter schief.
  // Ein Abbruch hinterlässt eine unvollständige Datei; --clobber ersetzt sie.
  for (const name of files) {
    for (let attempt = 1; ; attempt++) {
      if (assets()?.includes(name)) break;
      try {
        gh(['release', 'upload', tag, path.join(outDir, name), '--clobber']);
        break;
      } catch (error) {
        if (attempt >= UPLOAD_ATTEMPTS) throw error;
        console.error(`${name}: Versuch ${attempt} fehlgeschlagen, neuer Versuch`);
      }
    }
  }
  // Erst jetzt sichtbar (ein Entwurf, den CI schon um die Windows-Datei ergänzt hat, bleibt derselbe)
  gh(['release', 'edit', tag, '--draft=false']);
  console.log(`Mac-Dateien für ${tag} in ${repository}: ${files.join(', ')}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// Baut die iPad-App (ADR 0029) als unsignierte .ipa nach release/. SideStore signiert sie beim Installieren mit der
// Apple-ID des Nutzers. Ablauf: Oberfläche (vite.ios.config.ts) → Xcode (Release, iphoneos, ohne Signatur) → Payload/
// → ZIP. Läuft nur außerhalb der Claude-Sandbox (xcodebuild braucht die Dienste von Xcode).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });

run(process.execPath, [path.join(root, 'scripts/copy-pdfjs-assets.mjs')]);
run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '-c', 'vite.ios.config.ts', '--logLevel', 'warn']);

const derived = path.join(root, 'ios/build');
run('xcodebuild', [
  '-project', 'ios/Blattwerk.xcodeproj',
  '-scheme', 'Blattwerk',
  '-configuration', 'Release',
  '-sdk', 'iphoneos',
  '-derivedDataPath', derived,
  'CODE_SIGNING_ALLOWED=NO',
  'CODE_SIGNING_REQUIRED=NO',
  'CODE_SIGN_IDENTITY=',
  `MARKETING_VERSION=${version}`,
  `CURRENT_PROJECT_VERSION=${version}`,
  '-quiet',
  'build',
]);

const staging = path.join(derived, 'ipa');
rmSync(staging, { recursive: true, force: true });
mkdirSync(path.join(staging, 'Payload'), { recursive: true });
run('ditto', [path.join(derived, 'Build/Products/Release-iphoneos/Blattwerk.app'), path.join(staging, 'Payload/Blattwerk.app')]);
mkdirSync(path.join(root, 'release'), { recursive: true });
const target = path.join(root, 'release', `Blattwerk-${version}-iPad.ipa`);
rmSync(target, { force: true });
// ZIP ohne macOS-Zusatzdaten (__MACOSX, erweiterte Attribute)
run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', 'Payload', target], staging);
console.log(`iPad-App fertig: ${path.relative(root, target)}`);

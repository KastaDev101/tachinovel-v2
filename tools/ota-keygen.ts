/**
 * One-time setup of signed web updates (src/core/ota/ota.ts): makes an Ed25519 key pair.
 *
 *   node tools/ota-keygen.ts [--out=<folder outside the repo>]
 *
 * Writes the PRIVATE key (PKCS#8 PEM) to <out>/tachinovel-ota-signing-key.pem (default: your home
 * folder, never the repository) and prints the PUBLIC key plus the exact next steps:
 *   1. gh secret set OTA_SIGNING_KEY --repo KastaDev101/tachinovel-v2 < <that file>
 *   2. put the public key into src/core/ota/public-key.ts (OTA_PUBLIC_KEY) in a pull request
 *   3. keep the .pem somewhere safe offline (a password manager), then delete the file
 * Anyone with the private key can push code to the app, so it must never be committed or shared.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function generate(): { privatePem: string; publicRawBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  // SPKI DER for Ed25519 = 12-byte header + the raw 32-byte key (what CryptoKit's rawRepresentation wants).
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privatePem, publicRawBase64: der.subarray(der.length - 32).toString('base64') };
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const out = path.resolve(outArg ?? homedir());
  if (out === repoRoot || out.startsWith(repoRoot + path.sep)) {
    console.error('Refusing to write the private key inside the repository. Pass --out=<a folder outside it>.');
    process.exit(2);
  }
  const file = path.join(out, 'tachinovel-ota-signing-key.pem');
  if (existsSync(file)) {
    console.error(`${file} already exists; move it away first (a new key invalidates the old public key).`);
    process.exit(2);
  }
  const { privatePem, publicRawBase64 } = generate();
  mkdirSync(out, { recursive: true });
  writeFileSync(file, privatePem, { mode: 0o600 });
  console.log(`Private key: ${file}  (keep it secret)
Public key:  ${publicRawBase64}

Next:
  1. gh secret set OTA_SIGNING_KEY --repo KastaDev101/tachinovel-v2 < "${file}"
  2. In a pull request, set src/core/ota/public-key.ts to:
       export const OTA_PUBLIC_KEY = '${publicRawBase64}';
  3. Store the .pem offline (password manager), then delete ${file}.`);
}

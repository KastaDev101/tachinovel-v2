/**
 * Registers the native sources in ios/App/App.xcodeproj/project.pbxproj (no Mac needed).
 * The Capacitor template (objectVersion 60) has no synchronized folders, so every Swift file in
 * ios/App/App/Native/** must be listed explicitly. Idempotent: IDs are derived from file paths.
 *
 *   - group "Native" (all .swift under App/Native, in the Sources phase)
 *   - PrivacyInfo.xcprivacy (Resources phase), App.entitlements (CODE_SIGN_ENTITLEMENTS)
 *   - KokoroModels/ as a folder reference in the Resources phase: the bundled Kokoro voice model, fetched
 *     (pinned + checksummed) by tools/fetch-voices.ts at build time, never committed
 *   - the local Swift package ios/App/HDVoice (products HDVoiceCore, HDVoiceKokoro; it pins FluidAudio)
 *   - the local Swift package ios/App/ExpressiveVoice (product ExpressiveVoice: the EXPERIMENTAL expressive
 *     engines of the Voice Lab, models downloaded on demand; same FluidAudio pin)
 *   - IPHONEOS_DEPLOYMENT_TARGET 17.0 (Personal Voice, StoreKit 2 APIs used, safari17 JS target)
 *
 * Usage: node tools/ios-project.ts [--check]   (--check: exit 1 if the project is out of date)
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const appDir = path.join(root, 'ios', 'App', 'App');
const pbxPath = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const DEPLOYMENT_TARGET = '17.0';

/** Stable 24-hex-digit Xcode object id. */
export function oid(key: string): string {
  return createHash('md5').update(`tachinovel:${key}`).digest('hex').slice(0, 24).toUpperCase();
}

function swiftFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...swiftFiles(abs, r));
    else if (name.endsWith('.swift')) out.push(r);
  }
  return out;
}

function insertIntoSection(text: string, section: string, lines: string[]): string {
  const end = `/* End ${section} section */`;
  const i = text.indexOf(end);
  if (i < 0) throw new Error(`pbxproj: missing ${section} section`);
  // Skip objects already DEFINED (a line starting with exactly two tabs + the id); references to an
  // id elsewhere (lists, fileRef = …) don't count.
  const isDefined = (id: string): boolean => text.split('\n').some((line) => line.startsWith(`\t\t${id} `));
  const fresh = lines.filter((l) => !isDefined(l.trim().split(' ')[0] as string));
  return fresh.length === 0 ? text : text.slice(0, i) + fresh.join('') + text.slice(i);
}

/** Add ids to a `files = ( … );` / `children = ( … );` (or package) list of the object with this id. */
function addToList(text: string, objectId: string, listName: 'files' | 'children' | 'packageProductDependencies' | 'packageReferences', entries: string[]): string {
  // The DEFINITION line (exactly two tabs), not a reference inside another object's list.
  const start = text.indexOf(`\n\t\t${objectId} `);
  if (start < 0) throw new Error(`pbxproj: object ${objectId} not found`);
  const listStart = text.indexOf(`${listName} = (`, start);
  const close = text.indexOf('\n\t\t\t);', listStart);
  if (listStart < 0 || close < 0) throw new Error(`pbxproj: ${listName} list of ${objectId} not found`);
  const insertAt = close + 1; // after the newline, before "\t\t\t);"
  const body = text.slice(listStart, close);
  const fresh = entries.filter((e) => !body.includes(e.trim().split(' ')[0] as string));
  if (fresh.length === 0) return text;
  return text.slice(0, insertAt) + fresh.join('') + text.slice(insertAt);
}

function findId(text: string, pattern: RegExp, what: string): string {
  const m = pattern.exec(text);
  if (!m?.[1]) throw new Error(`pbxproj: cannot find ${what}`);
  return m[1];
}

export function updateProject(text: string, files: string[]): string {
  let t = text;
  const appGroup = findId(t, /\t\t([0-9A-F]{24}) \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;/, 'App group');
  const sources = findId(t, /\t\t([0-9A-F]{24}) \/\* Sources \*\/ = \{\n\t\t\tisa = PBXSourcesBuildPhase;/, 'Sources phase');
  const resources = findId(t, /\t\t([0-9A-F]{24}) \/\* Resources \*\/ = \{\n\t\t\tisa = PBXResourcesBuildPhase;/, 'Resources phase');

  const nativeGroup = oid('group:Native');
  const fileRefs: string[] = [];
  const buildFiles: string[] = [];
  const groupChildren: string[] = [];
  const sourceEntries: string[] = [];
  for (const rel of files) {
    const name = path.posix.basename(rel);
    const fr = oid(`file:Native/${rel}`);
    const bf = oid(`build:Native/${rel}`);
    fileRefs.push(`\t\t${fr} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "${rel}"; sourceTree = "<group>"; };\n`);
    buildFiles.push(`\t\t${bf} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fr} /* ${name} */; };\n`);
    groupChildren.push(`\t\t\t\t${fr} /* ${name} */,\n`);
    sourceEntries.push(`\t\t\t\t${bf} /* ${name} in Sources */,\n`);
  }
  const privacyRef = oid('file:PrivacyInfo.xcprivacy');
  const privacyBuild = oid('build:PrivacyInfo.xcprivacy');
  const entRef = oid('file:App.entitlements');
  fileRefs.push(`\t\t${privacyRef} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n`);
  fileRefs.push(`\t\t${entRef} /* App.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = "<group>"; };\n`);
  buildFiles.push(`\t\t${privacyBuild} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${privacyRef} /* PrivacyInfo.xcprivacy */; };\n`);

  t = insertIntoSection(t, 'PBXBuildFile', buildFiles);
  t = insertIntoSection(t, 'PBXFileReference', fileRefs);
  if (!t.includes(`${nativeGroup} /* Native */ = {`)) {
    t = insertIntoSection(t, 'PBXGroup', [
      `\t\t${nativeGroup} /* Native */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t);\n\t\t\tpath = Native;\n\t\t\tsourceTree = "<group>";\n\t\t};\n`,
    ]);
  }
  t = addToList(t, nativeGroup, 'children', groupChildren);
  t = addToList(t, appGroup, 'children', [`\t\t\t\t${nativeGroup} /* Native */,\n`, `\t\t\t\t${privacyRef} /* PrivacyInfo.xcprivacy */,\n`, `\t\t\t\t${entRef} /* App.entitlements */,\n`]);
  t = addToList(t, sources, 'files', sourceEntries);
  t = addToList(t, resources, 'files', [`\t\t\t\t${privacyBuild} /* PrivacyInfo.xcprivacy in Resources */,\n`]);
  t = addVoicePackage(t, appGroup, resources);

  // Build settings: deployment target everywhere; entitlements on the app target's configs.
  t = t.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${DEPLOYMENT_TARGET};`);
  t = t.replace(/(\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n)(?!\t\t\t\tCODE_SIGN_ENTITLEMENTS)/g, `$1\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n`);
  return t;
}

/** Local package HDVoice (+ its two library products) and the bundled KokoroModels folder. */
export const VOICE_PRODUCTS = ['HDVoiceCore', 'HDVoiceKokoro'] as const;
/** Local package ExpressiveVoice: the EXPERIMENTAL expressive engines (Voice Lab only, models downloaded on demand). */
export const EXPRESSIVE_PRODUCTS = ['ExpressiveVoice'] as const;

function addVoicePackage(text: string, appGroup: string, resources: string): string {
  let t = text;
  const modelsRef = oid('file:KokoroModels');
  const modelsBuild = oid('build:KokoroModels');
  t = insertIntoSection(t, 'PBXFileReference', [`\t\t${modelsRef} /* KokoroModels */ = {isa = PBXFileReference; lastKnownFileType = folder; path = KokoroModels; sourceTree = "<group>"; };\n`]);
  t = insertIntoSection(t, 'PBXBuildFile', [`\t\t${modelsBuild} /* KokoroModels in Resources */ = {isa = PBXBuildFile; fileRef = ${modelsRef} /* KokoroModels */; };\n`]);
  t = addToList(t, appGroup, 'children', [`\t\t\t\t${modelsRef} /* KokoroModels */,\n`]);
  t = addToList(t, resources, 'files', [`\t\t\t\t${modelsBuild} /* KokoroModels in Resources */,\n`]);
  t = addLocalPackage(t, 'HDVoice', VOICE_PRODUCTS);
  return addLocalPackage(t, 'ExpressiveVoice', EXPRESSIVE_PRODUCTS);
}

/** A local Swift package next to App.xcodeproj (ios/App/<name>), its library products linked into the app target. */
function addLocalPackage(text: string, name: string, products: readonly string[]): string {
  let t = text;
  const target = findId(t, /\t\t([0-9A-F]{24}) \/\* App \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/, 'App target');
  const project = findId(t, /\t\t([0-9A-F]{24}) \/\* Project object \*\/ = \{/, 'project object');
  const frameworks = findId(t, /\t\t([0-9A-F]{24}) \/\* Frameworks \*\/ = \{\n\t\t\tisa = PBXFrameworksBuildPhase;/, 'Frameworks phase');
  const pkg = oid(`package:${name}`);
  const ref = `XCLocalSwiftPackageReference "${name}"`;
  t = insertIntoSection(t, 'XCLocalSwiftPackageReference', [
    `\t\t${pkg} /* ${ref} */ = {\n\t\t\tisa = XCLocalSwiftPackageReference;\n\t\t\trelativePath = ${name};\n\t\t};\n`,
  ]);
  t = addToList(t, project, 'packageReferences', [`\t\t\t\t${pkg} /* ${ref} */,\n`]);
  for (const product of products) {
    const dep = oid(`product:${product}`);
    const build = oid(`build:product:${product}`);
    t = insertIntoSection(t, 'XCSwiftPackageProductDependency', [
      `\t\t${dep} /* ${product} */ = {\n\t\t\tisa = XCSwiftPackageProductDependency;\n\t\t\tpackage = ${pkg} /* ${ref} */;\n\t\t\tproductName = ${product};\n\t\t};\n`,
    ]);
    t = insertIntoSection(t, 'PBXBuildFile', [`\t\t${build} /* ${product} in Frameworks */ = {isa = PBXBuildFile; productRef = ${dep} /* ${product} */; };\n`]);
    t = addToList(t, target, 'packageProductDependencies', [`\t\t\t\t${dep} /* ${product} */,\n`]);
    t = addToList(t, frameworks, 'files', [`\t\t\t\t${build} /* ${product} in Frameworks */,\n`]);
  }
  return t;
}

/** Every 24-hex id referenced must be defined exactly once (catches broken edits on Windows). */
export function validateProject(text: string): string[] {
  const defined = new Map<string, number>();
  for (const m of text.matchAll(/^\t\t([0-9A-F]{24}) (?:\/\*[^*]*\*\/ )?= \{/gm)) defined.set(m[1] as string, (defined.get(m[1] as string) ?? 0) + 1);
  const problems: string[] = [];
  for (const [id, n] of defined) if (n > 1) problems.push(`defined ${n}x: ${id}`);
  for (const m of text.matchAll(/\b([0-9A-F]{24})\b/g)) if (!defined.has(m[1] as string)) problems.push(`undefined id: ${m[1]}`);
  let depth = 0;
  for (const ch of text.replace(/"(?:[^"\\]|\\.)*"/g, '')) {
    if (ch === '{' || ch === '(') depth++;
    if (ch === '}' || ch === ')') depth--;
  }
  if (depth !== 0) problems.push(`unbalanced brackets (${depth})`);
  return [...new Set(problems)];
}

if (import.meta.main) {
  const before = readFileSync(pbxPath, 'utf8');
  const files = swiftFiles(path.join(appDir, 'Native'));
  const after = updateProject(before, files);
  const problems = validateProject(after);
  if (problems.length > 0) {
    console.error(`project.pbxproj would be invalid:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    if (after !== before) {
      console.error('ios project is out of date: run node tools/ios-project.ts');
      process.exit(1);
    }
    console.log(`ios project ok (${files.length} native Swift files)`);
  } else {
    if (after !== before) writeFileSync(pbxPath, after);
    console.log(`${after === before ? 'unchanged' : 'updated'}: ${files.length} native Swift files registered`);
  }
}

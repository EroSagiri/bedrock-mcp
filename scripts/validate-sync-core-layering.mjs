#!/usr/bin/env node
/**
 * Static check that `packages/sync-core` stays runtime-neutral.
 *
 * Three consumers load it: a Cloudflare Worker (the Gateway), the Obsidian plugin's bundle, and the
 * local test pool. Anything with a runtime identity — a Worker binding, a Durable Object, an Obsidian
 * API, a Node built-in, an IndexedDB handle — would make one of those three unable to import it, and the
 * failure would surface as a bundler error in whichever repository shipped second, far from the change
 * that caused it.
 *
 * It runs in Node rather than in the vitest suite because the suite executes inside workerd, which has
 * no filesystem to read sources from. `npm run build` calls it, so a deployment cannot ship a package
 * that only one runtime could import.
 *
 * The audit reads *import specifiers*, not prose: the package's own documentation talks about Durable
 * Objects and Obsidian on purpose, and a word-matching check would forbid the explanation along with the
 * dependency.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDirectory = join(root, "packages", "sync-core");
const source = join(packageDirectory, "src");

/** Specifiers that would bind the shared protocol to one runtime. */
const forbidden = [
  { pattern: /^cloudflare:/, why: "Workers runtime API" },
  { pattern: /^obsidian$/, why: "Obsidian plugin API" },
  { pattern: /^node:/, why: "Node built-in" },
  { pattern: /^wrangler/, why: "deployment tooling" },
  { pattern: /(^|\/)apps\//, why: "a backend application" },
  { pattern: /^@mineral\/core/, why: "the backend-only core package" },
];

const failures = [];

function specifiers(text) {
  const found = [];
  for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^"'`\n]*?from\s*["']([^"']+)["']/g)) found.push(match[1]);
  for (const match of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]);
  return found;
}

const files = readdirSync(source).filter(entry => entry.endsWith(".ts"));
if (files.length < 5) failures.push(`expected the package to have several modules, found ${files.length}`);

for (const entry of files) {
  const path = join(source, entry);
  const text = readFileSync(path, "utf8");
  for (const specifier of specifiers(text)) {
    if (specifier.startsWith(".")) continue;
    for (const rule of forbidden) {
      if (rule.pattern.test(specifier)) failures.push(`packages/sync-core/src/${entry} imports ${specifier} (${rule.why})`);
    }
  }
}

const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
if (Object.keys(manifest.dependencies ?? {}).length > 0) failures.push(`packages/sync-core must declare no runtime dependencies (found ${Object.keys(manifest.dependencies).join(", ")})`);
for (const subpath of ["./hot-protocol", "./namespace-protocol", "./tombstones", "./paths", "./channel", "./gateway-protocol", "./gateway-subscribe", "./sync-change"]) {
  if (!manifest.exports?.[subpath]) failures.push(`packages/sync-core must export ${subpath} explicitly, so a bundler can never reach an unintended file`);
}

if (failures.length > 0) {
  console.error("sync-core layering validation failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("sync-core layering validation: PASS");

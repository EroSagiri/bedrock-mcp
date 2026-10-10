import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const packOnly = args.includes("--pack-only");
const sourceArgument = args.find(arg => !arg.startsWith("--"));
if (args.some(arg => arg.startsWith("--") && arg !== "--pack-only")) throw new Error("Usage: node scripts/vendor-textui.mjs [source] [--pack-only]");
const source = resolve(project, sourceArgument ?? (process.env.MINERAL_TEXTUI_PATH?.trim() || "../mineral-textui"));
const destination = join(project, "vendor");
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const runNpm = (args, cwd) => {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed`);
};
const room = JSON.parse(await readFile(join(project, "apps/room-apps/package.json"), "utf8"));

// Validate both packages before publishing either archive, so an invalid source fails before installation.
const packages = await Promise.all(["textui", "textui-react"].map(async name => {
  const from = join(source, "packages", name);
  const manifest = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
  if (manifest.name !== `@mineral/${name}`) throw new Error(`Unexpected package name for ${name}`);
  await readFile(join(from, "dist/index.js"));
  await readFile(join(from, "dist/index.d.ts"));
  const dependency = room.dependencies[manifest.name];
  if (!dependency?.startsWith("file:../../vendor/")) throw new Error(`Expected a vendor dependency for ${name}`);
  return { name, from, manifest, target: resolve(project, "apps/room-apps", dependency.slice("file:".length)) };
}));
await mkdir(destination, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), "mineral-textui-pack-"));
try {
  for (const { name, from, manifest, target } of packages) {
    const to = join(staging, name);
    await mkdir(to, { recursive: true });
    for (const [key, value] of Object.entries(manifest.dependencies ?? {})) {
      if (value.startsWith("workspace:")) manifest.dependencies[key] = JSON.parse(await readFile(join(source, "packages", key.split("/").at(-1), "package.json"), "utf8")).version;
    }
    delete manifest.scripts;
    delete manifest.devDependencies;
    await writeFile(join(to, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const file of ["dist", "README.md", ...(name === "textui-react" ? ["API.md"] : [])]) await cp(join(from, file), join(to, file), { recursive: true });
    // Dependency URLs remain stable when the local source version changes.
    const filename = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
    runNpm(["pack", "--ignore-scripts", "--loglevel", "error", "--pack-destination", to], to);
    await cp(join(to, filename), target);
  }
} finally {
  // Only the mkdtemp-created staging directory is disposable; never remove the source project.
  await rm(staging, { recursive: true, force: true });
}

if (!packOnly) {
  // Explicit file installs refresh npm's cached 0.0.0 packages after the source changes.
  runNpm(["install", ...packages.map(({ target }) => target), "--workspace", "apps/room-apps", "--ignore-scripts", "--force", "--no-audit", "--no-fund"], project);
}
console.log("Imported TextUI Core and React dependencies.");

import { build } from "esbuild";
import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repository = fileURLToPath(new URL("../", import.meta.url));

export async function buildHost(output) {
  const directory = resolve(output);
  await mkdir(directory);
  const result = await build({
    absWorkingDir: repository,
    entryPoints: ["packaging/entry.cts"],
    outfile: join(directory, "host.cjs"),
    bundle: true, platform: "node", format: "cjs", target: "node24",
    define: { "import.meta.main": "false", "import.meta.url": "undefined" },
    metafile: true, sourcemap: false, legalComments: "eof",
  });
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.startsWith("node_modules/")) continue;
    let location = dirname(resolve(repository, input));
    while (location !== repository) {
      const within = relative(repository, location);
      if (within.startsWith("..") || isAbsolute(within)) throw new Error("Dependency escaped repository.");
      try {
        const manifest = JSON.parse(await readFile(join(location, "package.json"), "utf8"));
        packages.set(location, manifest);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        location = dirname(location);
      }
    }
  }
  const notices = [];
  for (const [location, manifest] of packages) {
    const destination = join(directory, "licenses", relative(join(repository, "node_modules"), location));
    await mkdir(destination, { recursive: true });
    const names = (await readdir(location, { withFileTypes: true })).filter(entry => {
      const name = entry.name.toUpperCase();
      return entry.isFile() && ["LICENSE", "LICENCE", "NOTICE", "COPYING", "COPYRIGHT"].some(prefix => name.startsWith(prefix));
    }).map(entry => entry.name);
    for (const name of names) await copyFile(join(location, name), join(destination, name));
    notices.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? null,
      notices: names.map(name => relative(directory, join(destination, name)).split("\\").join("/")) });
  }
  await copyFile(join(repository, "LICENSE"), join(directory, "LICENSE"));
  await writeFile(join(directory, "dependencies.json"), JSON.stringify(notices, null, 2) + "\n");
  await writeFile(join(directory, "bundle-meta.json"), JSON.stringify(result.metafile, null, 2) + "\n");
  return directory;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true });
  if (!values.out) throw new Error("Usage: node packaging/build-host.mjs --out <new directory>");
  await buildHost(values.out);
}

import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { launch } from "../apps/launcher/index.ts";

const resources = isSea()
  ? join(dirname(process.execPath), process.platform === "darwin" ? "../Resources" : "resources")
  : __dirname;

void launch(join(resources, "dist"), join(resources, "components", "scene-detect"),
  join(resources, "components", "visual-search")).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Auto-cut startup failed.");
  process.exitCode = 1;
});

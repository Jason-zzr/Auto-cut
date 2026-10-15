import { fileURLToPath } from "node:url";
import { machineDirectory, openBrowser } from "./platform.ts";
import { claimInstance } from "../host/instance.ts";
import { startHost } from "../host/server.ts";

export async function launch(dist: string) {
  const instance = await claimInstance(await machineDirectory());
  if (!instance) return;
  let host: Awaited<ReturnType<typeof startHost>>;
  try {
    host = await startHost({ ...instance, dist, openBrowser });
  } catch (error) {
    try { await instance.release(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `Host startup failed: ${error instanceof Error ? error.message : "Unknown error."} Instance cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "Unknown error."}`);
    }
    throw error;
  }
  try { await instance.publish(host.port); }
  catch (error) { await host.stop(); throw error; }
  const stop = () => { void host.stop().catch(() => {
    console.error("Auto-cut shutdown failed; instance records were retained for inspection.");
    process.exitCode = 1;
  }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.info("Auto-cut local service ready. Closing the browser does not stop this service.");
  try { await host.reopen(); } catch {
    // Child-process errors can contain the bootstrap URL. Never print that error.
    console.error("The browser could not be opened. The service is still running; check ego lite on macOS or Chrome on Windows and run the launcher again.");
  }
}

if (import.meta.main) void launch(fileURLToPath(new URL("../../dist/", import.meta.url))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Auto-cut startup failed.");
  process.exitCode = 1;
});

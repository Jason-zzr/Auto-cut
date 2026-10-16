const MODEL_CACHE_WORKER_URL = "/model-cache-sw.js";
let registrationPromise = null;

function waitForController() {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 3000);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export function registerModelCacheServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(null);
  }

  registrationPromise ??= navigator.serviceWorker
    .register(MODEL_CACHE_WORKER_URL)
    .then(async (registration) => {
      await registration.update().catch(() => {});
      await navigator.serviceWorker.ready;
      await waitForController();
      return registration;
    })
    .catch((error) => {
      console.warn("Model cache service worker registration failed.", error);
      return null;
    });
  return registrationPromise;
}

export function waitForModelCacheServiceWorker() {
  return registerModelCacheServiceWorker();
}

export async function waitForHostMediaController() {
  const registration = await registerModelCacheServiceWorker();
  const controller = navigator.serviceWorker?.controller;
  if (!registration || !controller || new URL(controller.scriptURL).pathname !== MODEL_CACHE_WORKER_URL) {
    throw new Error("项目媒体服务尚未就绪，请重新打开页面。");
  }
  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const requestId = crypto.randomUUID();
    const finish = (error) => {
      clearTimeout(timer); channel.port1.close(); channel.port2.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("项目媒体服务需要更新，请重新打开页面。")), 3000);
    channel.port1.onmessage = ({ data }) => {
      if (data?.type === "AUTOCUT_MEDIA_READY" && data.requestId === requestId) finish();
    };
    try { controller.postMessage({ type: "AUTOCUT_MEDIA_READY", requestId }, [channel.port2]); }
    catch (error) { finish(error); }
  });
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const rootEl = document.getElementById("root");
const PRELOAD_RELOAD_KEY = "WB_vite_preload_reload";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const showError = (err) => {
  if (!rootEl) return;
  const message = err?.stack || err?.message || String(err);
  rootEl.innerHTML = `
    <div style="min-height:100vh;background:#0b0d12;color:#e7e9ee;padding:32px;font-family:Arial,sans-serif;">
      <h1 style="margin:0 0 12px 0;font-size:20px;">Ошибка приложения</h1>
      <div style="color:#a0a6b5;margin-bottom:12px;">Скопируйте текст и пришлите мне.</div>
      <pre style="white-space:pre-wrap;background:#151a23;padding:16px;border-radius:12px;border:1px solid #232936;">${escapeHtml(message)}</pre>
    </div>
  `;
};

window.addEventListener("error", (event) => {
  showError(event?.error || event?.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showError(event?.reason || "Unhandled promise rejection");
});

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  try {
    if (window.sessionStorage.getItem(PRELOAD_RELOAD_KEY) === "1") {
      window.sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
      showError(event?.payload || "Не удалось догрузить обновлённые файлы приложения.");
      return;
    }
    window.sessionStorage.setItem(PRELOAD_RELOAD_KEY, "1");
  } catch {
    // Ignore storage issues and still try a single forced reload.
  }
  const url = new URL(window.location.href);
  url.searchParams.set("_reload", String(Date.now()));
  window.location.replace(url.toString());
});

import("./App.jsx")
  .then((module) => {
    if (!rootEl) return;
    const AppComponent = module.default;
    try {
      window.sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
    } catch {
      // Ignore storage cleanup issues after a successful boot.
    }
    createRoot(rootEl).render(
      <StrictMode>
        <AppComponent />
      </StrictMode>
    );
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.has("_reload")) {
      currentUrl.searchParams.delete("_reload");
      const next = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
      window.history.replaceState({}, "", next);
    }
  })
  .catch(showError);

// kizo:web.todomvc.web_ui.todo_pwa_shell — entry point
import initAddTodoInput from "./add-todo-input.js";
import initTodoListView from "./todo-list-view.js";
import initFooterView from "./footer-view.js";
import initFilterRouter from "./filter-router.js";

// Defensive: unregister any service worker left over from a different
// app that previously ran on this origin (e.g., a POS on localhost:3000),
// and clear its caches so the user is not served stale HTML/JS/CSS.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    let unregistered = false;
    for (const r of regs) {
      r.unregister();
      unregistered = true;
    }
    if (unregistered && "caches" in window) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
  }).catch(() => {});
}

const store = {
  todos: [],
  filter: "all",
  error: null,
};

const errorBanner = document.querySelector(".error-banner");

function render() {
  if (store.__listView_render) store.__listView_render();
  if (store.__footer_render) store.__footer_render();

  if (errorBanner) {
    if (store.error) {
      errorBanner.textContent = String(store.error);
      errorBanner.hidden = false;
    } else {
      errorBanner.hidden = true;
    }
  }
}

async function bootstrap() {
  initAddTodoInput({ store, render });
  initTodoListView({ store, render });
  initFooterView({ store, render });
  initFilterRouter({ store, render });

  try {
    const res = await fetch("/api/todos");
    if (res.ok) {
      store.todos = await res.json();
      store.error = null;
    } else {
      store.error = `failed to load todos (${res.status})`;
    }
  } catch {
    store.error = "network error loading todos";
  }
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  void bootstrap();
}

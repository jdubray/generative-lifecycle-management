// kizo:web.todomvc.web_ui.todo_filter_router
const VALID = new Set(["all", "active", "completed"]);

export function hashToFilter(hash) {
  switch (hash) {
    case "":
    case "#":
    case "#/":
      return { filter: "all", rewrite: false };
    case "#/active":
      return { filter: "active", rewrite: false };
    case "#/completed":
      return { filter: "completed", rewrite: false };
    default:
      return { filter: "all", rewrite: true };
  }
}

export default function init({ store, render }) {
  const resolve = () => {
    const { filter, rewrite } = hashToFilter(window.location.hash);
    if (rewrite) {
      // history.replaceState keeps history clean and triggers no hashchange
      try {
        history.replaceState(null, "", "#/");
      } catch {
        window.location.hash = "#/";
      }
    }
    if (!VALID.has(filter)) {
      store.filter = "all";
    } else {
      store.filter = filter;
    }
    render();
  };

  window.addEventListener("hashchange", resolve);
  // Initial dispatch on load
  resolve();
}

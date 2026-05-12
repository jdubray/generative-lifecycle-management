// kizo:web.todomvc.web_ui.footer_view
import { countActive } from "./filter.js";

export default function init({ store, render }) {
  const footer = document.querySelector("footer.footer");
  if (!footer) throw new Error("footer.footer not found");

  // single click listener scoped to clear-completed
  footer.addEventListener("click", async (e) => {
    if (!e.target.matches("button.clear-completed")) return;
    try {
      const res = await fetch("/api/todos/completed", { method: "DELETE" });
      if (res.ok) {
        store.todos = store.todos.filter((t) => !t.completed);
        store.error = null;
      } else {
        store.error = `clear-completed failed (${res.status})`;
      }
    } catch {
      store.error = "network error";
    }
    render();
  });

  store.__footer_render = () => {
    if (store.todos.length === 0) {
      footer.style.display = "none";
      footer.innerHTML = "";
      return;
    }
    footer.style.display = "";

    const active = countActive(store.todos);
    const anyCompleted = store.todos.some((t) => t.completed);

    const countLabel =
      active === 1
        ? `<strong>1</strong> item left`
        : `<strong>${active}</strong> items left`;

    const links = [
      { hash: "#/", label: "All", value: "all" },
      { hash: "#/active", label: "Active", value: "active" },
      { hash: "#/completed", label: "Completed", value: "completed" },
    ]
      .map(
        (l) =>
          `<li><a href="${l.hash}"${
            store.filter === l.value ? ' class="selected"' : ""
          }>${l.label}</a></li>`
      )
      .join("");

    footer.innerHTML = `
      <span class="todo-count">${countLabel}</span>
      <ul class="filters">${links}</ul>
      ${anyCompleted ? `<button class="clear-completed">Clear completed</button>` : ""}
    `;
  };
}

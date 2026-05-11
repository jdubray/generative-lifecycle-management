// kizo:web.todomvc.web_ui.todo_list_view
import { filter } from "./filter.js";
import { createEditFsm } from "./edit-mode-fsm.js";

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));

export default function init({ store, render }) {
  const main = document.querySelector("section.main");
  const list = document.querySelector("ul.todo-list");
  const toggleAll = document.getElementById("toggle-all");
  if (!main || !list || !toggleAll) throw new Error("list view DOM missing");

  // single editing-id at a time (per BR-LIST-007)
  let editingId = null;
  let activeFsm = null;

  const enterEdit = (id, currentTitle) => {
    editingId = id;
    activeFsm = createEditFsm({
      onCommit: async (newTitle) => {
        await patchTodo(id, { title: newTitle });
        editingId = null;
        activeFsm = null;
        render();
      },
      onCancel: (restored) => {
        // discard — no API call (BR-LIST-003)
        editingId = null;
        activeFsm = null;
        render();
      },
      onDestroy: async () => {
        await deleteTodo(id);
        editingId = null;
        activeFsm = null;
        render();
      },
    });
    activeFsm.doubleClick(currentTitle);
    render();
  };

  const patchTodo = async (id, patch) => {
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const updated = await res.json();
        const i = store.todos.findIndex((t) => t.id === id);
        if (i >= 0) store.todos[i] = updated;
        store.error = null;
      } else if (res.status === 404) {
        store.todos = store.todos.filter((t) => t.id !== id);
      } else {
        store.error = `update failed (${res.status})`;
      }
    } catch {
      store.error = "network error";
    }
  };

  const deleteTodo = async (id) => {
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.status === 204 || res.status === 404) {
        store.todos = store.todos.filter((t) => t.id !== id);
        store.error = null;
      } else {
        store.error = `delete failed (${res.status})`;
      }
    } catch {
      store.error = "network error";
    }
  };

  const handleToggle = async (id, nextCompleted) => {
    await patchTodo(id, { completed: nextCompleted });
    render();
  };

  const handleToggleAll = async () => {
    const target = store.todos.some((t) => !t.completed);
    try {
      const res = await fetch("/api/todos/toggle-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: target }),
      });
      if (res.ok) {
        for (const t of store.todos) t.completed = target;
        store.error = null;
      } else {
        store.error = `toggle-all failed (${res.status})`;
      }
    } catch {
      store.error = "network error";
    }
    render();
  };

  // event delegation on ul.todo-list
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const id = li.dataset.id;

    if (e.target.matches("button.destroy")) {
      void deleteTodo(id).then(render);
      return;
    }
    if (e.target.matches("input.toggle")) {
      const next = e.target.checked;
      void handleToggle(id, next);
      return;
    }
  });

  list.addEventListener("dblclick", (e) => {
    if (!e.target.matches("label")) return;
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const id = li.dataset.id;
    const todo = store.todos.find((t) => t.id === id);
    if (!todo) return;
    enterEdit(id, todo.title);
  });

  list.addEventListener(
    "keydown",
    (e) => {
      if (!e.target.matches("input.edit")) return;
      if (!activeFsm) return;
      if (e.key === "Enter") {
        e.preventDefault();
        activeFsm.pressEnter(e.target.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        activeFsm.pressEscape();
      }
    }
  );

  list.addEventListener(
    "blur",
    (e) => {
      if (!e.target.matches("input.edit")) return;
      if (!activeFsm) return;
      activeFsm.blur(e.target.value);
    },
    true
  );

  toggleAll.addEventListener("change", () => {
    void handleToggleAll();
  });

  // expose render so app.js can call it; the view reads from store at each render.
  store.__listView_render = () => {
    const visible = filter(store.filter, store.todos);
    const allCompleted =
      store.todos.length > 0 && store.todos.every((t) => t.completed);
    toggleAll.checked = allCompleted;

    main.style.display = store.todos.length > 0 ? "" : "none";

    list.innerHTML = visible
      .map((t) => {
        const isEditing = t.id === editingId;
        const liClass = [
          t.completed ? "completed" : "",
          isEditing ? "editing" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<li data-id="${escape(t.id)}"${liClass ? ` class="${liClass}"` : ""}>
          <div class="view">
            <input class="toggle" type="checkbox"${t.completed ? " checked" : ""}>
            <label>${escape(t.title)}</label>
            <button class="destroy" aria-label="Delete"></button>
          </div>
          ${isEditing ? `<input class="edit" value="${escape(t.title)}">` : ""}
        </li>`;
      })
      .join("");

    if (editingId) {
      const editInput = list.querySelector("li.editing input.edit");
      if (editInput) {
        editInput.focus();
        const len = editInput.value.length;
        editInput.setSelectionRange(len, len);
      }
    }
  };
}

// kizo:web.todomvc.web_ui.add_todo_input
export default function init({ store, render }) {
  const input = document.querySelector("input.new-todo");
  if (!input) throw new Error("input.new-todo not found");

  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    if (event.isComposing || event.keyCode === 229) return; // IME guard

    const raw = input.value;
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    input.disabled = true;
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (res.status === 201) {
        const todo = await res.json();
        store.todos.push(todo);
        input.value = "";
        store.error = null;
        render();
      } else {
        let msg = `add failed (${res.status})`;
        try {
          const body = await res.json();
          msg = body.message || msg;
        } catch {}
        store.error = msg;
        render();
      }
    } catch (err) {
      store.error = "network error";
      render();
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
}

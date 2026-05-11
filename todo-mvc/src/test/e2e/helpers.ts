import type { APIRequestContext, Page } from "@playwright/test";

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

export async function wipeAllTodos(request: APIRequestContext): Promise<void> {
  const res = await request.get("/api/todos");
  const todos: Todo[] = await res.json();
  for (const t of todos) {
    await request.delete(`/api/todos/${encodeURIComponent(t.id)}`);
  }
}

export async function createTodo(
  request: APIRequestContext,
  title: string
): Promise<Todo> {
  const res = await request.post("/api/todos", { data: { title } });
  return res.json();
}

export async function addTodoViaUI(page: Page, title: string): Promise<void> {
  await page.locator("input.new-todo").fill(title);
  await page.locator("input.new-todo").press("Enter");
  // Wait for the new <li> to appear (the title is escaped on render)
  await page.locator(`ul.todo-list li`).filter({ hasText: title }).waitFor({
    state: "visible",
    timeout: 3000,
  });
}

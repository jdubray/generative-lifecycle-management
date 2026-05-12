// Acceptance: kizo:web.todomvc.web_ui.todo_pwa_shell.spec.acceptance
import { test, expect } from "@playwright/test";
import { wipeAllTodos, addTodoViaUI } from "./helpers";

test.beforeEach(async ({ request }) => {
  await wipeAllTodos(request);
});

test.describe("TodoMVC PWA Shell", () => {
  test("page.title() === 'TodoMVC'", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("TodoMVC");
  });

  test("input.new-todo is focused on page load", async ({ page }) => {
    await page.goto("/");
    const input = page.locator("input.new-todo");
    await expect(input).toBeFocused();
  });

  test("input.new-todo has placeholder text matching input_placeholder", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("input.new-todo")).toHaveAttribute(
      "placeholder",
      "What needs to be done?"
    );
  });

  test("section.main is hidden when there are zero todos", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("section.main")).toBeHidden();
  });

  test("footer.footer is hidden when there are zero todos", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("footer.footer")).toBeHidden();
  });

  test("after one todo is added, both section.main and footer.footer are visible", async ({
    page,
  }) => {
    await page.goto("/");
    await addTodoViaUI(page, "buy milk");
    await expect(page.locator("section.main")).toBeVisible();
    await expect(page.locator("footer.footer")).toBeVisible();
  });

  test("all required_selectors in spec.schema are present in the DOM", async ({
    page,
  }) => {
    await page.goto("/");

    // Page shell selectors (always present)
    await expect(page.locator("section.todoapp")).toHaveCount(1);
    await expect(page.locator("header.header")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText("todos");
    await expect(page.locator("input.new-todo")).toHaveCount(1);
    await expect(page.locator("input.new-todo")).toHaveAttribute(
      "autofocus",
      ""
    );
    await expect(page.locator("section.main")).toHaveCount(1);
    await expect(page.locator("input#toggle-all.toggle-all")).toHaveCount(1);
    await expect(page.locator("label[for='toggle-all']")).toHaveCount(1);
    await expect(page.locator("ul.todo-list")).toHaveCount(1);
    await expect(page.locator("footer.footer")).toHaveCount(1);
    await expect(page.locator("footer.info")).toHaveCount(1);

    // li.children selectors — visible only when a todo exists
    await addTodoViaUI(page, "first");
    await expect(page.locator("ul.todo-list li")).toHaveCount(1);
    await expect(page.locator("ul.todo-list li div.view")).toHaveCount(1);
    await expect(
      page.locator("ul.todo-list li div.view input.toggle[type='checkbox']")
    ).toHaveCount(1);
    await expect(page.locator("ul.todo-list li div.view label")).toHaveCount(1);
    await expect(
      page.locator("ul.todo-list li div.view button.destroy")
    ).toHaveCount(1);
  });
});

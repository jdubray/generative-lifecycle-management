// Acceptance: kizo:web.todomvc.web_ui.footer_view.spec.acceptance
import { test, expect } from "@playwright/test";
import { wipeAllTodos, addTodoViaUI } from "./helpers";

test.beforeEach(async ({ request }) => {
  await wipeAllTodos(request);
});

test.describe("Footer View", () => {
  test("Empty list → footer.footer is not visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("footer.footer")).toBeHidden();
  });

  test("Add 1 todo → todo-count text is '1 item left'", async ({ page }) => {
    await page.goto("/");
    await addTodoViaUI(page, "one");
    await expect(page.locator("span.todo-count")).toHaveText("1 item left");
  });

  test("Add 2 todos → todo-count text is '2 items left'", async ({ page }) => {
    await page.goto("/");
    await addTodoViaUI(page, "one");
    await addTodoViaUI(page, "two");
    await expect(page.locator("span.todo-count")).toHaveText("2 items left");
  });

  test("Toggle 1 of 2 → '1 item left'", async ({ page }) => {
    await page.goto("/");
    await addTodoViaUI(page, "one");
    await addTodoViaUI(page, "two");
    await page
      .locator("ul.todo-list li")
      .first()
      .locator("input.toggle")
      .check();
    await expect(page.locator("span.todo-count")).toHaveText("1 item left");
  });

  test("Toggle all → '0 items left' AND clear-completed is visible", async ({
    page,
  }) => {
    await page.goto("/");
    await addTodoViaUI(page, "one");
    await addTodoViaUI(page, "two");
    await page.locator("#toggle-all").check();
    await expect(page.locator("span.todo-count")).toHaveText("0 items left");
    await expect(page.locator("button.clear-completed")).toBeVisible();
  });

  test("Click clear-completed → completed removed; footer hides if empty", async ({
    page,
  }) => {
    await page.goto("/");
    await addTodoViaUI(page, "one");
    await addTodoViaUI(page, "two");
    await page
      .locator("ul.todo-list li")
      .first()
      .locator("input.toggle")
      .check();
    await page.locator("button.clear-completed").click();
    await expect(page.locator("ul.todo-list li")).toHaveCount(1);
    await expect(page.locator("button.clear-completed")).toHaveCount(0);

    // Toggle remaining + clear → list empty + footer hides
    await page
      .locator("ul.todo-list li")
      .first()
      .locator("input.toggle")
      .check();
    await page.locator("button.clear-completed").click();
    await expect(page.locator("footer.footer")).toBeHidden();
  });

  test("Filter links update URL hash and the 'selected' class", async ({
    page,
  }) => {
    await page.goto("/");
    await addTodoViaUI(page, "one");

    await page.locator("ul.filters a", { hasText: "Active" }).click();
    await expect(page).toHaveURL(/#\/active$/);
    await expect(
      page.locator("ul.filters a", { hasText: "Active" })
    ).toHaveClass(/selected/);

    await page.locator("ul.filters a", { hasText: "Completed" }).click();
    await expect(page).toHaveURL(/#\/completed$/);
    await expect(
      page.locator("ul.filters a", { hasText: "Completed" })
    ).toHaveClass(/selected/);

    await page.locator("ul.filters a", { hasText: "All" }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator("ul.filters a", { hasText: "All" })).toHaveClass(
      /selected/
    );
  });

  test("Only ONE filter link has class='selected' at any time", async ({
    page,
  }) => {
    await page.goto("/");
    await addTodoViaUI(page, "one");

    await page.locator("ul.filters a", { hasText: "Active" }).click();
    await expect(page.locator("ul.filters a.selected")).toHaveCount(1);

    await page.locator("ul.filters a", { hasText: "Completed" }).click();
    await expect(page.locator("ul.filters a.selected")).toHaveCount(1);

    await page.locator("ul.filters a", { hasText: "All" }).click();
    await expect(page.locator("ul.filters a.selected")).toHaveCount(1);
  });
});

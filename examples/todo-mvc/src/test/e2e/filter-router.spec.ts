// Acceptance: kizo:web.todomvc.web_ui.todo_filter_router.spec.acceptance
import { test, expect } from "@playwright/test";
import { wipeAllTodos, createTodo } from "./helpers";

test.beforeEach(async ({ request }) => {
  await wipeAllTodos(request);
  // Seed one active + one completed so filter visibility is observable
  const a = await createTodo(request, "active-one");
  const c = await createTodo(request, "completed-one");
  await request.patch(`/api/todos/${encodeURIComponent(c.id)}`, {
    data: { completed: true },
  });
});

test.describe("Todo Filter Router", () => {
  test("Open at /#/active → only active items rendered; Active link selected", async ({
    page,
  }) => {
    await page.goto("/#/active");
    await expect(page.locator("ul.todo-list li")).toHaveCount(1);
    await expect(page.locator("ul.todo-list li.completed")).toHaveCount(0);
    await expect(
      page.locator("ul.filters a", { hasText: "Active" })
    ).toHaveClass(/selected/);
  });

  test("Open at /#/ → all items; All link selected", async ({ page }) => {
    await page.goto("/#/");
    await expect(page.locator("ul.todo-list li")).toHaveCount(2);
    await expect(page.locator("ul.filters a", { hasText: "All" })).toHaveClass(
      /selected/
    );
  });

  test("Open at /#/completed → only completed; Completed link selected", async ({
    page,
  }) => {
    await page.goto("/#/completed");
    await expect(page.locator("ul.todo-list li")).toHaveCount(1);
    await expect(page.locator("ul.todo-list li.completed")).toHaveCount(1);
    await expect(
      page.locator("ul.filters a", { hasText: "Completed" })
    ).toHaveClass(/selected/);
  });

  test("Open at /#/garbage → URL is rewritten to /#/ AND filter is 'all'", async ({
    page,
  }) => {
    await page.goto("/#/garbage");
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator("ul.todo-list li")).toHaveCount(2);
    await expect(page.locator("ul.filters a", { hasText: "All" })).toHaveClass(
      /selected/
    );
  });

  test("Click Active link → URL becomes #/active and list re-renders", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("ul.filters a", { hasText: "Active" }).click();
    await expect(page).toHaveURL(/#\/active$/);
    await expect(page.locator("ul.todo-list li")).toHaveCount(1);
    await expect(page.locator("ul.todo-list li.completed")).toHaveCount(0);
  });

  test("Click All link → URL becomes #/ and list re-renders", async ({
    page,
  }) => {
    await page.goto("/#/active");
    await page.locator("ul.filters a", { hasText: "All" }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator("ul.todo-list li")).toHaveCount(2);
  });

  test("Browser back after clicking through filters → URL and selected link match", async ({
    page,
  }) => {
    await page.goto("/#/");
    await page.locator("ul.filters a", { hasText: "Active" }).click();
    await expect(page).toHaveURL(/#\/active$/);
    await page.locator("ul.filters a", { hasText: "Completed" }).click();
    await expect(page).toHaveURL(/#\/completed$/);

    await page.goBack();
    await expect(page).toHaveURL(/#\/active$/);
    await expect(
      page.locator("ul.filters a", { hasText: "Active" })
    ).toHaveClass(/selected/);

    await page.goBack();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator("ul.filters a", { hasText: "All" })).toHaveClass(
      /selected/
    );
  });
});

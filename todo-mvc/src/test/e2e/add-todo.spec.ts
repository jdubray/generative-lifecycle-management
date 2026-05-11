// Acceptance: kizo:web.todomvc.web_ui.add_todo_input.spec.acceptance
import { test, expect } from "@playwright/test";
import { wipeAllTodos } from "./helpers";

test.beforeEach(async ({ request }) => {
  await wipeAllTodos(request);
});

test.describe("Add Todo Input", () => {
  test("Enter on non-empty title → <li> appears, input is cleared", async ({
    page,
  }) => {
    await page.goto("/");
    const input = page.locator("input.new-todo");
    await input.fill("buy milk");
    await input.press("Enter");
    await expect(
      page.locator("ul.todo-list li").filter({ hasText: "buy milk" })
    ).toHaveCount(1);
    await expect(input).toHaveValue("");
  });

  test("Enter on whitespace-only → no <li>, input keeps spaces", async ({
    page,
  }) => {
    await page.goto("/");
    const input = page.locator("input.new-todo");
    let postCount = 0;
    await page.route("**/api/todos", (route) => {
      if (route.request().method() === "POST") postCount++;
      return route.continue();
    });
    await input.fill("   ");
    await input.press("Enter");
    // Give the page a tick — no network call expected
    await page.waitForTimeout(150);
    await expect(page.locator("ul.todo-list li")).toHaveCount(0);
    await expect(input).toHaveValue("   ");
    expect(postCount).toBe(0);
  });

  test("Two Enters → two <li>s in insertion order", async ({ page }) => {
    await page.goto("/");
    const input = page.locator("input.new-todo");
    await input.fill("a");
    await input.press("Enter");
    await expect(
      page.locator("ul.todo-list li").filter({ hasText: "a" })
    ).toHaveCount(1);
    await input.fill("b");
    await input.press("Enter");
    const labels = page.locator("ul.todo-list li label");
    await expect(labels).toHaveCount(2);
    await expect(labels.nth(0)).toHaveText("a");
    await expect(labels.nth(1)).toHaveText("b");
  });

  test("Network error → input NOT cleared, error banner appears", async ({
    page,
  }) => {
    await page.goto("/");
    await page.route("**/api/todos", (route) => {
      if (route.request().method() === "POST") return route.abort("failed");
      return route.continue();
    });
    const input = page.locator("input.new-todo");
    await input.fill("offline");
    await input.press("Enter");
    await expect(input).toHaveValue("offline");
    await expect(page.locator(".error-banner")).toBeVisible();
  });

  test("IME composition Enter → no fetch is made", async ({ page }) => {
    await page.goto("/");
    let postCount = 0;
    await page.route("**/api/todos", (route) => {
      if (route.request().method() === "POST") postCount++;
      return route.continue();
    });

    await page.evaluate(() => {
      const input = document.querySelector(
        "input.new-todo"
      ) as HTMLInputElement;
      input.value = "あいう";
      const ev = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      // jsdom-style: define isComposing on the event before dispatch
      Object.defineProperty(ev, "isComposing", { value: true });
      input.dispatchEvent(ev);
    });

    await page.waitForTimeout(150);
    expect(postCount).toBe(0);
    await expect(page.locator("ul.todo-list li")).toHaveCount(0);
  });
});

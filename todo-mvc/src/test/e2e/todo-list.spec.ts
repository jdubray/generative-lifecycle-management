// Acceptance: kizo:web.todomvc.web_ui.todo_list_view.spec.acceptance
import { test, expect } from "@playwright/test";
import { wipeAllTodos, addTodoViaUI } from "./helpers";

test.beforeEach(async ({ request }) => {
  await wipeAllTodos(request);
});

const seed = async (page: any, titles: string[]) => {
  await page.goto("/");
  for (const t of titles) {
    await addTodoViaUI(page, t);
  }
};

test.describe("Todo List View", () => {
  test("Add 3 todos → ul.todo-list has 3 <li>s in insertion order", async ({
    page,
  }) => {
    await seed(page, ["one", "two", "three"]);
    const labels = page.locator("ul.todo-list li label");
    await expect(labels).toHaveCount(3);
    await expect(labels.nth(0)).toHaveText("one");
    await expect(labels.nth(1)).toHaveText("two");
    await expect(labels.nth(2)).toHaveText("three");
  });

  test("Click toggle on item 2 → li.completed on item 2 only", async ({
    page,
  }) => {
    await seed(page, ["one", "two", "three"]);
    const items = page.locator("ul.todo-list li");
    await items.nth(1).locator("input.toggle").check();
    await expect(items.nth(0)).not.toHaveClass(/completed/);
    await expect(items.nth(1)).toHaveClass(/completed/);
    await expect(items.nth(2)).not.toHaveClass(/completed/);
  });

  test("Hover item 1 → button.destroy is visible (CSS check)", async ({
    page,
  }) => {
    await seed(page, ["one"]);
    const destroy = page.locator("ul.todo-list li button.destroy").first();
    await expect(destroy).toBeAttached();
    // Initial: hidden via display:none
    const initialDisplay = await destroy.evaluate(
      (el) => getComputedStyle(el).display
    );
    expect(initialDisplay).toBe("none");

    await page.locator("ul.todo-list li").first().hover();
    await expect
      .poll(async () => destroy.evaluate((el) => getComputedStyle(el).display))
      .not.toBe("none");
  });

  test("Click destroy on item 1 → only 2 <li>s remain", async ({ page }) => {
    await seed(page, ["one", "two", "three"]);
    const items = page.locator("ul.todo-list li");
    await items.first().hover();
    await items.first().locator("button.destroy").click();
    await expect(page.locator("ul.todo-list li")).toHaveCount(2);
  });

  test("Toggle-all then toggle-all → all completed then all active", async ({
    page,
  }) => {
    await seed(page, ["a", "b", "c"]);
    await page.locator("#toggle-all").check();
    const completedCount = page.locator("ul.todo-list li.completed");
    await expect(completedCount).toHaveCount(3);
    await page.locator("#toggle-all").uncheck();
    await expect(page.locator("ul.todo-list li.completed")).toHaveCount(0);
  });

  test("Double-click label → li.editing, input.edit focused, value matches", async ({
    page,
  }) => {
    await seed(page, ["edit me"]);
    await page.locator("ul.todo-list li label").first().dblclick();
    const li = page.locator("ul.todo-list li").first();
    await expect(li).toHaveClass(/editing/);
    const editInput = li.locator("input.edit");
    await expect(editInput).toBeFocused();
    await expect(editInput).toHaveValue("edit me");
  });

  test("Edit: type ' updated', Enter → label is original+' updated' trimmed", async ({
    page,
  }) => {
    await seed(page, ["edit me"]);
    const li = page.locator("ul.todo-list li").first();
    await li.locator("label").dblclick();
    const editInput = li.locator("input.edit");
    // Use type so the existing value is preserved + we append.
    // setSelectionRange has cursor at end already.
    await editInput.type(" updated");
    await editInput.press("Enter");
    await expect(
      page.locator("ul.todo-list li label").first()
    ).toHaveText("edit me updated");
    await expect(page.locator("ul.todo-list li.editing")).toHaveCount(0);
  });

  test("Edit: clear text, Enter → <li> is removed entirely", async ({
    page,
  }) => {
    await seed(page, ["delete-via-edit"]);
    const li = page.locator("ul.todo-list li").first();
    await li.locator("label").dblclick();
    const editInput = li.locator("input.edit");
    await editInput.fill("");
    await editInput.press("Enter");
    await expect(page.locator("ul.todo-list li")).toHaveCount(0);
  });

  test("Edit: change text, Escape → original kept, no PATCH issued", async ({
    page,
  }) => {
    await seed(page, ["keep me"]);
    let patchCount = 0;
    await page.route("**/api/todos/*", (route) => {
      if (route.request().method() === "PATCH") patchCount++;
      return route.continue();
    });

    const li = page.locator("ul.todo-list li").first();
    await li.locator("label").dblclick();
    const editInput = li.locator("input.edit");
    await editInput.type(" changed");
    await editInput.press("Escape");

    await expect(page.locator("ul.todo-list li label").first()).toHaveText(
      "keep me"
    );
    expect(patchCount).toBe(0);
  });

  test("Edit: blur the input → behaves like Enter (commits)", async ({
    page,
  }) => {
    await seed(page, ["blur me"]);
    const li = page.locator("ul.todo-list li").first();
    await li.locator("label").dblclick();
    const editInput = li.locator("input.edit");
    await editInput.type(" committed");
    // Blur by clicking outside the edit input (the page body)
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await expect(page.locator("ul.todo-list li label").first()).toHaveText(
      "blur me committed"
    );
  });

  test("Filter set to 'active' → completed items not rendered at all", async ({
    page,
  }) => {
    await seed(page, ["a", "b"]);
    await page.locator("ul.todo-list li").nth(0).locator("input.toggle").check();
    await page.evaluate(() => {
      window.location.hash = "#/active";
    });
    await expect(page.locator("ul.todo-list li.completed")).toHaveCount(0);
    await expect(page.locator("ul.todo-list li")).toHaveCount(1);
  });

  test("Filter set to 'completed' → only completed rendered", async ({
    page,
  }) => {
    await seed(page, ["a", "b"]);
    await page.locator("ul.todo-list li").nth(0).locator("input.toggle").check();
    await page.evaluate(() => {
      window.location.hash = "#/completed";
    });
    await expect(page.locator("ul.todo-list li")).toHaveCount(1);
    await expect(page.locator("ul.todo-list li.completed")).toHaveCount(1);
  });
});

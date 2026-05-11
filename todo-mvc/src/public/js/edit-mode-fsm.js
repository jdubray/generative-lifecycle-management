// Per-item edit-mode FSM. Implements kizo:web.todomvc.web_ui.todo_list_view.edit_mode_fsm
// States: VIEWING, EDITING, DELETED (terminal).
export const States = Object.freeze({
  VIEWING: "VIEWING",
  EDITING: "EDITING",
  DELETED: "DELETED",
});

export function createEditFsm({ onCommit, onCancel, onDestroy }) {
  let state = States.VIEWING;
  let originalTitle = null;

  return {
    get state() {
      return state;
    },
    get originalTitle() {
      return originalTitle;
    },
    doubleClick(currentTitle) {
      if (state !== States.VIEWING) return;
      originalTitle = currentTitle;
      state = States.EDITING;
    },
    pressEnter(inputValue) {
      if (state !== States.EDITING) return;
      const trimmed = inputValue.trim();
      if (trimmed.length === 0) {
        state = States.DELETED;
        onDestroy();
      } else {
        state = States.VIEWING;
        onCommit(trimmed);
      }
      originalTitle = null;
    },
    blur(inputValue) {
      if (state !== States.EDITING) return;
      // blur behaves like Enter — commit, not cancel
      this.pressEnter(inputValue);
    },
    pressEscape() {
      if (state !== States.EDITING) return;
      const restored = originalTitle;
      originalTitle = null;
      state = States.VIEWING;
      onCancel(restored);
    },
    destroyClick() {
      state = States.DELETED;
      onDestroy();
    },
  };
}

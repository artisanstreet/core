// Forge view barrel: stable import surface (`./pages/forgeview.ts`).
// New code imports from `./forge-view/<module>` directly.

export { render_forge } from "./forge-view/connection.ts";
export { open_thread } from "./forge-view/thread-detail.ts";
export type { ObjectUrlTracker } from "./forge-view/thread-detail.ts";
export { open_threads } from "./forge-view/thread-list.ts";

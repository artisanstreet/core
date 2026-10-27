// Forge view barrel: stable import surface (`./pages/forgeview.ts`).
// New code imports from `./forge-view/<module>` directly.

export { renderForge } from "./forge-view/connection.ts";
export { openThread } from "./forge-view/thread-detail.ts";
export type { ObjectUrlTracker } from "./forge-view/thread-detail.ts";
export { openThreads } from "./forge-view/thread-list.ts";

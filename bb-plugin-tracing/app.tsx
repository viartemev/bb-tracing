// bb-plugin-tracing — the frontend.
//
// - Every answer gets a chip in its action row (duration, tool count) that
//   opens that turn's trace in the side panel.
// - The thread panel has a Traces launcher listing every traced turn.
// - A Tracing page in the sidebar shows all threads and the server's health.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Dashboard } from "./ui/Dashboard.tsx";
import { TRACE_TAB, TraceBadge } from "./ui/TraceBadge.tsx";
import { ThreadTraces } from "./ui/TurnTrace.tsx";

function turnIdOf(params: unknown): string | null {
  if (params && typeof params === "object" && "turnId" in params) {
    const turnId = (params as { turnId: unknown }).turnId;
    if (typeof turnId === "string" && turnId.length > 0 && turnId.length <= 200) return turnId;
  }
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_messageMetadata({
    id: "turn-trace",
    placement: "actionRow",
    component: TraceBadge,
  });

  app.slots.experimental_tab({
    ...TRACE_TAB,
    title: "Traces",
    icon: "tracing/activity",
    layout: "flush",
    component: ({ threadId, params }) => (
      // Remount per turn so the tab's own selection starts from its params.
      <ThreadTraces key={turnIdOf(params) ?? "all"} threadId={threadId} initialTurnId={turnIdOf(params)} />
    ),
  });

  app.slots.navPanel({
    id: "tracing",
    title: "Tracing",
    icon: "tracing/activity",
    path: "tracing",
    component: Dashboard,
  });
});

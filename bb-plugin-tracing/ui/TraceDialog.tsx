// The trace viewer as a large modal over the thread, opened from an answer's
// chip. Radix Dialog is provided by bb at runtime, so it layers correctly
// with bb's own overlays.
import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { TraceViewer } from "./TraceViewer.tsx";

export function TraceDialog({
  threadId,
  turnId,
  open,
  onOpenChange,
  children,
}: {
  threadId: string;
  turnId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        {/* The portal renders under <body>, outside the plugin root that
            scopes this plugin's CSS; the attribute brings the styles along. */}
        <Dialog.Overlay data-bb-plugin="tracing" className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-bb-plugin="tracing"
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 h-[82vh] w-[min(72rem,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-background shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">Trace</Dialog.Title>
          {open && <TraceViewer threadId={threadId} turnId={turnId} onClose={() => onOpenChange(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

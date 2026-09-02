"use client";

import { Button } from "@/components/ui";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  wide?: boolean;
}

export function Modal({ open, onClose, title, children, wide }: ModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-xl border border-border bg-bg-elevated p-6 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="mb-4 flex items-start justify-between">
            <h2 className="text-lg font-bold text-fg">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-fg-muted hover:bg-gray-100 hover:text-fg-muted"
              aria-label="Close"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  confirmVariant?: "primary" | "danger";
  confirming?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  confirmVariant = "danger",
  confirming,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="text-sm text-fg-muted">{description}</div>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="secondary" type="button" onClick={onClose} disabled={confirming}>
          Cancel
        </Button>
        <Button
          variant={confirmVariant}
          type="button"
          onClick={onConfirm}
          disabled={confirming}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
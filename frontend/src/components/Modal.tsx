import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Built on native <dialog> deliberately — it gives focus trapping, ESC-to-
 * close, and the top-layer/backdrop for free from the browser, rather than
 * hand-rolling a focus trap (Section 4's keyboard-navigation standard is
 * easy to get subtly wrong by hand). Used for create/edit forms under ~6
 * fields per Section 3.4; anything longer is a dedicated page.
 */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className="w-full max-w-md rounded-card border border-border bg-surface p-0 text-text-primary backdrop:bg-[color-mix(in_srgb,black_50%,transparent)] open:animate-none"
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
          <X size={16} />
        </Button>
      </div>
      <div className="p-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
    </dialog>
  );
}

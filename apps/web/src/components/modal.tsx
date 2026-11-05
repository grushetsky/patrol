import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "./icons";

/**
 * The prototype's modal: a native <dialog> dressed as the glass card, so the
 * browser supplies the focus trap, ESC handling, and backdrop semantics the
 * prototype's <dialog> had.
 */
export function Modal(props: {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { open, title, closeLabel, onClose, children } = props;
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <article className="modal-card">
        <header className="modal-head">
          <span id="modal-title">{title}</span>
          <button type="button" className="modal-close" onClick={onClose}>
            <Icon name="x" size="sm" />
            <span className="sr-only">{closeLabel}</span>
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </article>
    </dialog>
  );
}

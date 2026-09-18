import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Kind = 'info' | 'error';
type Toast = (message: string, kind?: Kind) => void;

const ToastContext = createContext<Toast>(() => undefined);

// Confirmations may fade; errors stay until dismissed, because a message the
// user cannot re-read is the same as no message at all.
const INFO_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Array<{ id: number; message: string; kind: Kind }>>([]);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const toast = useCallback<Toast>((message, kind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current.slice(-3), { id, message, kind }]);
    if (kind !== 'error') setTimeout(() => { dismiss(id); }, INFO_MS);
  }, [dismiss]);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            <span>{item.message}</span>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(item.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

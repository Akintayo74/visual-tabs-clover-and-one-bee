export const TOAST_HOST_ID = 'visual-memory-toast';

export type ToastState = 'saving' | 'saved' | 'error';

/**
 * Shows or updates the in-page save toast. Injected with `scripting.executeScript({ func })`,
 * so it must be self-contained. Lives in a closed shadow root so page styles can't reach it.
 */
export function renderToast(hostId: string, state: ToastState, message: string): void {
  const store = window as unknown as {
    __visualMemoryToast?: { host: HTMLElement; root: ShadowRoot; timer: number };
  };
  let toastState = store.__visualMemoryToast;
  if (!toastState?.host.isConnected || toastState.host.id !== hostId) {
    const host = document.createElement('div');
    host.id = hostId;
    host.style.cssText =
      'all: initial; position: fixed; z-index: 2147483647; right: 20px; bottom: 20px;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .toast { font: 500 14px/1.3 system-ui, sans-serif; color: #fff; background: #1f1f23;
          padding: 10px 14px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.25);
          display: flex; gap: 8px; align-items: center; max-width: 320px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; flex: none; }
        .saved .dot { background: #34c759; }
        .error .dot { background: #ff453a; }
      </style>
      <div class="toast" role="status" aria-live="polite"><span class="dot"></span><span class="msg"></span></div>`;
    document.documentElement.appendChild(host);
    toastState = { host, root, timer: 0 };
    store.__visualMemoryToast = toastState;
  }
  const { host, root } = toastState;
  const toast = root.querySelector('.toast');
  const msg = root.querySelector('.msg');
  if (!toast || !msg) return;
  toast.className = `toast ${state}`;
  msg.textContent = message;
  host.dataset.state = state;
  clearTimeout(toastState.timer);
  if (state !== 'saving') {
    toastState.timer = window.setTimeout(
      () => {
        host.remove();
      },
      state === 'error' ? 5000 : 2200,
    );
  }
}

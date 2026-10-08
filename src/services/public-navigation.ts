/** Mobile navigation with keyboard, pointer and responsive-state cleanup. */
export function setupPublicNavigation(
  toggle: HTMLButtonElement,
  menu: HTMLElement,
  region: HTMLElement,
  signal: AbortSignal,
): void {
  const mobile = window.matchMedia('(max-width: 780px)');
  const setOpen = (open: boolean): void => {
    toggle.setAttribute('aria-expanded', String(open));
    menu.classList.toggle('is-open', open);
  };
  const close = (focus = false): void => {
    const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
    setOpen(false);
    if (focus && wasOpen) toggle.focus();
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'), { signal });
  region.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && mobile.matches) {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      if (open) { event.preventDefault(); close(true); }
    }
  }, { signal });
  menu.addEventListener('click', (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('a')) close();
  }, { signal });
  document.addEventListener('pointerdown', (event: PointerEvent) => {
    if (mobile.matches && !region.contains(event.target as Node)) close();
  }, { signal });
  mobile.addEventListener('change', () => close(), { signal });
  signal.addEventListener('abort', () => close(), { once: true });
}

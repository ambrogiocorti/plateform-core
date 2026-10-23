import { safeError } from '../api/client';

export type Child = Node | string | number | null | undefined | false;
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith('on') || name === 'innerHTML' || name === 'srcdoc')
      throw new Error('Unsafe attribute');
    element.setAttribute(name, value);
  }
  for (const child of children)
    if (child !== null && child !== undefined && child !== false)
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}
export function button(
  label: string,
  action: () => void | Promise<void>,
  variant = 'primary',
): HTMLButtonElement {
  const node = el('button', { type: 'button', class: `button ${variant}` }, label);
  node.addEventListener('click', () => {
    if (node.disabled) return;
    node.disabled = true;
    node.setAttribute('aria-busy', 'true');
    Promise.resolve()
      .then(action)
      .catch(showError)
      .finally(() => {
        node.disabled = false;
        node.removeAttribute('aria-busy');
      });
  });
  return node;
}
export function field(
  label: string,
  name: string,
  type = 'text',
  value = '',
): { root: HTMLElement; input: HTMLInputElement } {
  const id = `field-${crypto.randomUUID()}`;
  const input = el('input', { id, name, type, value });
  return { root: el('div', { class: 'field' }, el('label', { for: id }, label), input), input };
}
export function status(label: string): HTMLElement {
  return el('span', { class: 'status' }, label.replaceAll('_', ' '));
}
/** `h1` when the state is the whole page, so every page keeps exactly one main heading. */
export function emptyState(
  title: string,
  description: string,
  heading: 'h1' | 'h2' = 'h2',
): HTMLElement {
  return el('section', { class: 'empty-state' }, el(heading, {}, title), el('p', {}, description));
}
/** Moves focus to the page content without a #main fragment jump, which fires popstate and
 * makes the routers re-render the page instead of moving focus. */
export function enableSkipLink(): void {
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a.skip-link') : null;
    const main = document.getElementById('main');
    if (!link || !main) return;
    event.preventDefault();
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    main.focus();
    main.scrollIntoView();
  });
}
export function loading(): HTMLElement {
  return el('p', { role: 'status', class: 'loading' }, 'Caricamento…');
}
export function showError(error: unknown): void {
  const failure = safeError(error);
  toast(`${failure.message} · Rif. ${failure.requestId.slice(0, 8)}`, true);
}
export function toast(message: string, isError = false): void {
  let region = document.getElementById('toasts');
  if (!region) {
    region = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    document.body.append(region);
  }
  const item = el(
    'div',
    { class: `toast ${isError ? 'error' : ''}`, role: isError ? 'alert' : 'status' },
    message,
  );
  item.append(button('Chiudi', () => item.remove(), 'quiet'));
  region.append(item);
  if (!isError) setTimeout(() => item.remove(), 7000);
}
export function dialog(title: string, ...content: Child[]): HTMLDialogElement {
  const element = el(
    'dialog',
    { class: 'dialog', 'aria-label': title },
    el('header', {}, el('h2', {}, title)),
    ...content,
  );
  element.append(button('Chiudi', () => element.close(), 'quiet'));
  const previousFocus = document.activeElement;
  element.addEventListener('close', () => {
    element.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  });
  document.body.append(element);
  element.showModal();
  return element;
}

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
    // Rewrite absolute internal anchors in public GitHub Pages project previews.
    const base = import.meta.env.BASE_URL;
    const localPublicLink =
      tag === 'a' &&
      name === 'href' &&
      import.meta.env.PLATEFORM_AREA === 'public' &&
      typeof base === 'string' &&
      base !== '/' &&
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.startsWith(base);
    element.setAttribute(name, localPublicLink ? `${base.replace(/\/$/, '')}${value}` : value);
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
export function emptyState(title: string, description: string): HTMLElement {
  return el('section', { class: 'empty-state' }, el('h2', {}, title), el('p', {}, description));
}
export function loading(): HTMLElement {
  return el('p', { role: 'status', class: 'loading' }, 'Caricamento…');
}
export function showError(error: unknown): void {
  const failure = safeError(error);
  toast(failure.message, true, failure.requestId);
}
export function dismissControl(label: string, action: () => void): HTMLButtonElement {
  const control = button('', action, 'quiet');
  control.classList.add('dismiss-control');
  control.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', 'm6 6 12 12 M18 6 6 18');
  svg.append(shape);
  control.append(svg);
  return control;
}
export function toast(message: string, isError = false, requestId?: string): void {
  let region = document.getElementById('toasts');
  if (!region) {
    region = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
  }
  placeFeedback(region);
  if (
    requestId &&
    [...region.children].some((item) => (item as HTMLElement).dataset.requestId === requestId)
  )
    return;
  // A form shows its current validation state, rather than accumulating errors
  // from earlier attempts that the operator has already corrected.
  if (region.parentElement instanceof HTMLDialogElement) region.replaceChildren();
  const item = el(
    'div',
    { class: `toast ${isError ? 'error' : ''}`, role: isError ? 'alert' : 'status' },
    el('span', { class: 'toast-icon', 'aria-hidden': 'true' }, isError ? '!' : '✓'),
    el(
      'div',
      { class: 'toast-content' },
      el('strong', { class: 'toast-title' }, isError ? 'Attenzione' : 'Confermato'),
      el('p', { class: 'toast-message' }, message),
      requestId
        ? el('span', { class: 'toast-reference' }, `Riferimento ${requestId.slice(0, 8)}`)
        : null,
    ),
  );
  if (requestId) item.dataset.requestId = requestId;
  item.append(dismissControl('Nascondi avviso', () => item.remove()));
  region.append(item);
  while (region.children.length > 3) region.firstElementChild?.remove();
  if (!isError) setTimeout(() => item.remove(), 7000);
}
function placeFeedback(region: HTMLElement): void {
  const host = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
  if (host) {
    const heading = host.querySelector(':scope > .dialog-heading');
    host.insertBefore(region, heading?.nextSibling ?? host.firstChild);
  } else document.body.append(region);
}
export function dialog(title: string, ...content: Child[]): HTMLDialogElement {
  const element = el(
    'dialog',
    { class: 'dialog', 'aria-label': title },
    el('header', { class: 'dialog-heading' }, el('h2', {}, title)),
    ...content,
  );
  element.querySelector('header')!.append(dismissControl('Chiudi finestra', () => element.close()));
  const previousFocus = document.activeElement;
  element.addEventListener('close', () => {
    const feedback = element.querySelector<HTMLElement>(':scope > #toasts');
    // Successful operations often close their form immediately. Keep their confirmation
    // in the next open dialog, or in the page, instead of removing it with the old form.
    if (feedback) document.body.append(feedback);
    element.remove();
    if (feedback) placeFeedback(feedback);
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true });
  });
  let pressedBackdrop = false;
  const outside = (event: MouseEvent): boolean => {
    const bounds = element.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  };
  element.addEventListener('pointerdown', (event) => {
    pressedBackdrop = event.target === element && outside(event);
  });
  element.addEventListener('click', (event) => {
    if (pressedBackdrop && event.target === element && outside(event)) element.close();
    pressedBackdrop = false;
  });
  document.body.append(element);
  element.showModal();
  return element;
}

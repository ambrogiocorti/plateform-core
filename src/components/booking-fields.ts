import { el, field } from './dom';
export interface BookingField {
  id: string;
  type: string;
  label: string;
  required: boolean;
  options: string[];
  placeholder?: string | null | undefined;
}
export function bookingField(
  entry: BookingField,
  previous?: unknown,
): { root: HTMLElement; value: () => unknown; valid: () => boolean } {
  const root = el('fieldset', { class: 'field' }, el('legend', {}, entry.label));
  if (entry.type === 'checkbox' && entry.options.length) {
    const choices = entry.options.map((option) => {
      const input = el('input', { type: 'checkbox' });
      input.checked = Array.isArray(previous) && previous.includes(option);
      root.append(el('label', {}, input, option));
      return { option, input };
    });
    return {
      root,
      value: () => choices.filter((c) => c.input.checked).map((c) => c.option),
      valid: () => !entry.required || choices.some((c) => c.input.checked),
    };
  }
  if (entry.type === 'radio') {
    const choices = entry.options.map((option) => {
      const input = el('input', { type: 'radio', name: entry.id, value: option });
      input.required = entry.required;
      input.checked = previous === option;
      root.append(el('label', {}, input, option));
      return input;
    });
    return {
      root,
      value: () => choices.find((c) => c.checked)?.value ?? null,
      valid: () => choices.every((c) => c.reportValidity()),
    };
  }
  if (entry.type === 'select') {
    const input = el(
      'select',
      { 'aria-label': entry.label },
      el('option', { value: '' }, 'Seleziona'),
      ...entry.options.map((option) => el('option', { value: option }, option)),
    );
    input.required = entry.required;
    input.value = typeof previous === 'string' ? previous : '';
    root.append(input);
    return { root, value: () => input.value || null, valid: () => input.reportValidity() };
  }
  if (entry.type === 'textarea') {
    const input = el('textarea', {
      rows: '3',
      maxlength: '2000',
      'aria-label': entry.label,
      placeholder: entry.placeholder ?? '',
    });
    input.required = entry.required;
    input.value = typeof previous === 'string' ? previous : '';
    root.append(input);
    return { root, value: () => input.value, valid: () => input.reportValidity() };
  }
  const input = field(
    entry.label,
    entry.id,
    entry.type,
    previous === undefined ? '' : String(previous),
  ).input;
  input.required = entry.required;
  if (entry.type === 'checkbox') input.checked = previous === true;
  else input.placeholder = entry.placeholder ?? '';
  root.append(input);
  return {
    root,
    value: () =>
      entry.type === 'checkbox'
        ? input.checked
        : entry.type === 'number'
          ? input.value
            ? Number(input.value)
            : null
          : input.value,
    valid: () => input.reportValidity(),
  };
}

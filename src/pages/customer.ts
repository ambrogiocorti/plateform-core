import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApplicationError, client, rpc } from '../api/client';
import { button, dialog, el, field, toast } from '../components/dom';
import { menuDishSchema } from '../types/domain';
import { availabilityBadge, validateOrderSelection } from '../services/menu';
import { formatMoney } from '../services/money';
import type { OrderLine } from '../types/domain';
import { watchLive } from '../realtime/live';
import { safeImageUrl } from '../config/environment';

interface CustomerCart {
  lines: OrderLine[];
  key: string;
  submitted: OrderLine[] | null;
  changed: () => void;
}

async function customerSessionFailure(error: unknown): Promise<never> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = z
        .object({ code: z.string(), request_id: z.string().optional() })
        .parse(await error.context.json());
      if (payload.code === 'RATE_LIMITED')
        throw new ApplicationError(
          'RATE_LIMITED',
          payload.request_id ?? crypto.randomUUID(),
          'Troppi tentativi. Attendi qualche istante prima di riprovare.',
        );
      if (payload.code === 'UNAUTHORIZED')
        throw new ApplicationError(
          'UNAUTHORIZED',
          payload.request_id ?? crypto.randomUUID(),
          'Codice non valido per questo tavolo. Controllalo e riprova.',
        );
    } catch (parsed) {
      if (parsed instanceof ApplicationError) throw parsed;
    }
  }
  throw error;
}

function cartSummary(lines: readonly OrderLine[]): string {
  return lines.length
    ? `${lines.reduce((sum, item) => sum + item.quantity, 0)} pietanze nel carrello`
    : 'Il carrello è vuoto';
}

const accountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  covers: z.number(),
  venue_id: z.uuid(),
  currency: z.string(),
  locale: z.string(),
  balance: z.object({ total_cents: z.number(), remaining_cents: z.number() }),
  customer_ordering: z.enum(['DISABLED', 'WAITER_APPROVAL', 'DIRECT']),
  bill_request_enabled: z.boolean(),
  items: z.array(
    z.object({
      name: z.string(),
      quantity: z.number(),
      unit_price_cents: z.number(),
      ordered_at: z.string(),
      removed_ingredients: z.array(z.string()),
      variants: z.array(z.object({ group: z.string(), option: z.string() })),
    }),
  ),
  requests: z.array(
    z.object({
      id: z.uuid(),
      status: z.string(),
      reason: z.string().nullable().optional(),
      created_at: z.string(),
      resolved_at: z.string().nullable().optional(),
    }),
  ),
});

export async function customerPage(publicTable: string, signal: AbortSignal): Promise<HTMLElement> {
  z.uuid().parse(publicTable);
  const container = el('section', { class: 'public-section' });
  const cart: CustomerCart = {
    lines: [],
    key: crypto.randomUUID(),
    submitted: null,
    changed: () => {
      const label = container.querySelector('[data-cart-summary]');
      if (label) label.textContent = cartSummary(cart.lines);
    },
  };
  let stopLive: (() => void) | undefined;
  let liveAccount: string | undefined;
  let request = 0;
  signal.addEventListener(
    'abort',
    () => {
      stopLive?.();
    },
    { once: true },
  );
  const refresh = async () => {
    const revision = ++request;
    try {
      const content = await customerContent(publicTable, refresh, cart, async (account) => {
        if (liveAccount === account.id || signal.aborted) return;
        const {
          data: { session },
        } = await client().auth.getSession();
        if (!session) return;
        stopLive?.();
        liveAccount = account.id;
        stopLive = watchLive({
          venueId: account.venue_id,
          userId: session.user.id,
          topics: ['ACCOUNT', 'PUBLIC'],
          refresh: async () => {
            if (!document.querySelector('dialog[open]')) await refresh();
          },
          accessChanged: async () => {
            try {
              await rpc('get_customer_account', { p_public_table: publicTable }, accountSchema);
            } catch (error) {
              if (error instanceof ApplicationError && error.code === 'CUSTOMER_SESSION_REQUIRED')
                showCode();
              else throw error;
            }
          },
          state: (state) => {
            const label = container.querySelector('[data-connection]');
            if (label)
              label.textContent =
                state === 'OFFLINE'
                  ? 'MODALITÀ OFFLINE'
                  : state === 'LIVE'
                    ? 'Conto connesso'
                    : 'Aggiornamenti da verificare';
          },
        });
      });
      if (!signal.aborted && request === revision) {
        container.replaceChildren(content);
        cart.changed();
      }
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'CUSTOMER_SESSION_REQUIRED')
        showCode();
      else throw error;
    }
  };
  function showCode(): void {
    stopLive?.();
    stopLive = undefined;
    liveAccount = undefined;
    request++;
    cart.lines.length = 0;
    cart.submitted = null;
    cart.key = crypto.randomUUID();
    for (const modal of document.querySelectorAll('dialog')) modal.close();
    container.replaceChildren();
    const code = field('Codice del conto', 'code');
    code.input.inputMode = 'numeric';
    code.input.pattern = '[0-9]{6}';
    code.input.maxLength = 6;
    code.input.required = true;
    code.input.autocomplete = 'one-time-code';
    let deviceId = localStorage.getItem('plateform-customer-device');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem('plateform-customer-device', deviceId);
    }
    container.append(
      el(
        'div',
        { class: 'booking-form' },
        el('p', { class: 'eyebrow' }, 'Benvenuto a tavola'),
        el('h1', {}, 'Il tuo conto, a portata di mano.'),
        el('p', { class: 'muted' }, 'Inserisci il codice a sei cifre ricevuto dal cameriere.'),
        code.root,
        button('Apri il mio conto', async () => {
          if (!code.input.reportValidity()) return;
          const secret = code.input.value;
          code.input.value = '';
          const { data, error } = await client().functions.invoke('customer-session', {
            body: { public_table_id: publicTable, code: secret, device_id: deviceId },
          });
          if (error) await customerSessionFailure(error);
          const session = z
            .object({ access_token: z.string(), refresh_token: z.string() })
            .parse(data);
          const { error: sessionError } = await client().auth.setSession(session);
          if (sessionError) throw sessionError;
          await refresh();
        }),
      ),
    );
  }
  const {
    data: { session },
  } = await client().auth.getSession();
  if (session) await refresh();
  else showCode();
  return container;
}

async function customerContent(
  publicTable: string,
  refresh: () => Promise<void>,
  cartState: CustomerCart,
  ready: (account: z.infer<typeof accountSchema>) => Promise<void>,
): Promise<HTMLElement> {
  const account = await rpc('get_customer_account', { p_public_table: publicTable }, accountSchema);
  const content = el(
    'div',
    { class: 'stack' },
    el('p', { class: 'eyebrow' }, 'Il tuo tavolo'),
    el('h1', {}, account.name),
    el(
      'p',
      { 'data-connection': '', class: 'muted', role: 'status' },
      'Aggiornamenti da verificare',
    ),
    el(
      'div',
      { class: 'customer-account-summary' },
      el('p', { class: 'muted' }, `${account.covers} persone`),
      el(
        'div',
        { class: 'stack compact customer-account-total' },
        el('span', { class: 'muted' }, 'Totale corrente'),
        el(
          'div',
          { class: 'amount' },
          formatMoney(account.balance.total_cents, account.currency, account.locale),
        ),
        account.balance.remaining_cents !== account.balance.total_cents
          ? el(
              'span',
              { class: 'muted' },
              `Da saldare: ${formatMoney(account.balance.remaining_cents, account.currency, account.locale)}`,
            )
          : null,
      ),
    ),
  );
  content.append(
    el(
      'div',
      { class: 'row' },
      button(
        'Chiama il cameriere',
        async () => {
          await rpc('call_waiter', { p_account: account.id, p_kind: 'WAITER' }, z.uuid());
          toast('Il cameriere è stato avvisato.');
        },
        'secondary',
      ),
      account.bill_request_enabled
        ? button(
            'Richiedi il conto',
            async () => {
              await rpc('call_waiter', { p_account: account.id, p_kind: 'BILL' }, z.uuid());
              toast('La richiesta del conto è stata inviata.');
            },
            'secondary',
          )
        : null,
    ),
  );
  if (account.items.length)
    content.append(
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Già ordinato'),
        ...account.items.map((item) => {
          const details = [
            item.removed_ingredients.length ? `Senza ${item.removed_ingredients.join(', ')}` : null,
            item.variants.length
              ? item.variants.map((variant) => `${variant.group}: ${variant.option}`).join(' · ')
              : null,
          ].filter(Boolean);
          return el(
            'div',
            { class: 'account-history-line' },
            el(
              'div',
              { class: 'row between' },
              el('p', {}, `${item.quantity} × ${item.name}`),
              el(
                'strong',
                {},
                formatMoney(
                  item.quantity * item.unit_price_cents,
                  account.currency,
                  account.locale,
                ),
              ),
            ),
            details.length ? el('p', { class: 'muted' }, details.join(' · ')) : null,
          );
        }),
      ),
    );
  if (account.requests.some((request) => request.status === 'PENDING'))
    content.append(
      el(
        'p',
        { role: 'status' },
        'Hai una richiesta d’ordine in attesa di conferma del cameriere.',
      ),
    );
  const rejected = account.requests.find((request) => request.status === 'REJECTED');
  if (rejected)
    content.append(
      el(
        'p',
        { role: 'status' },
        rejected.reason
          ? `L’ultima richiesta è stata rifiutata: ${rejected.reason}`
          : 'L’ultima richiesta d’ordine è stata rifiutata dal cameriere.',
      ),
    );
  const dishes = await rpc(
    'get_public_menu',
    { p_venue: account.venue_id },
    z.array(menuDishSchema),
  );
  const cart = cartState.lines;
  const cartLabel = el('span', { 'data-cart-summary': '' });
  const updateCartLabel = () => {
    cartLabel.textContent = cartSummary(cart);
    cartState.changed();
  };
  updateCartLabel();
  const menu = el(
    'section',
    { class: 'customer-menu stack' },
    el('h2', {}, 'Cosa ti va di assaggiare?'),
  );
  content.append(menu);
  if (!dishes.length)
    menu.append(
      el('p', { class: 'muted' }, 'Il menu non ha proposte disponibili in questo momento.'),
    );
  const categories = Array.from(
    new Map(dishes.map((dish) => [dish.category_id, dish.category_name] as const)).entries(),
  );
  for (const [categoryId, categoryName] of categories) {
    menu.append(el('h3', { class: 'menu-category' }, categoryName));
    const grid = el('div', { class: 'dish-grid' });
    for (const dish of dishes.filter((entry) => entry.category_id === categoryId)) {
      const picture = safeImageUrl(dish.image_path);
      const card = el(
        'article',
        { class: 'dish-public' },
        picture ? el('img', { src: picture, alt: dish.name, loading: 'lazy' }) : null,
        el(
          'div',
          { class: 'row between' },
          el('h3', {}, dish.name),
          el('strong', {}, formatMoney(dish.price_cents, account.currency, account.locale)),
        ),
        el('p', {}, dish.description),
        !dish.beverage && dish.ingredients.length
          ? el('p', {}, `Ingredienti: ${dish.ingredients.map((item) => item.name).join(', ')}`)
          : null,
        dish.allergens.length
          ? el(
              'p',
              { class: 'allergens' },
              `Contiene: ${dish.allergens.map((item) => item.name).join(', ')}`,
            )
          : null,
        dish.dietary_tags.length
          ? el(
              'div',
              { class: 'row' },
              ...dish.dietary_tags.map((tag) => el('span', { class: 'status' }, tag.label)),
            )
          : null,
      );
      const badge = availabilityBadge(dish.availability);
      if (badge.label) card.append(el('p', { class: 'status' }, badge.label));
      if (account.customer_ordering !== 'DISABLED') {
        const add = button('Scegli', () => {
          if (cartState.submitted) {
            toast(
              'La richiesta è già stata inviata. Verificane l’esito prima di aggiungere altre pietanze.',
            );
            return;
          }
          const quantity = field('Quantità', 'quantity', 'number', '1');
          quantity.input.min = '1';
          quantity.input.max = String(dish.availability ?? 999);
          const line: OrderLine = {
            dish_id: dish.id,
            quantity: 1,
            step: 1,
            removed_ingredients: [],
            variant_options: [],
          };
          const editor = dialog(dish.name, quantity.root);
          for (const ingredient of dish.ingredients.filter((item) => item.removable)) {
            const check = el('input', { type: 'checkbox' });
            check.addEventListener('change', () => {
              line.removed_ingredients = check.checked
                ? [...line.removed_ingredients, ingredient.id]
                : line.removed_ingredients.filter((id) => id !== ingredient.id);
            });
            editor.append(
              el('label', { class: 'checkbox-line' }, check, `Senza ${ingredient.name}`),
            );
          }
          for (const group of dish.variant_groups) {
            editor.append(
              el(
                'p',
                {},
                `${group.name}${group.required ? ' · richiesta' : ''} · massimo ${group.max_selections}`,
              ),
            );
            for (const option of group.options) {
              const check = el('input', { type: 'checkbox' });
              check.addEventListener('change', () => {
                line.variant_options = check.checked
                  ? [...line.variant_options, option.id]
                  : line.variant_options.filter((id) => id !== option.id);
              });
              editor.append(el('label', { class: 'checkbox-line' }, check, option.label));
            }
          }
          editor.append(
            button('Aggiungi al carrello', () => {
              if (cartState.submitted) return;
              if (!quantity.input.reportValidity()) return;
              line.quantity = Number(quantity.input.value);
              const errors = validateOrderSelection(dish, line);
              if (errors.length) {
                toast(errors.join(' '), true);
                return;
              }
              cart.push(line);
              updateCartLabel();
              editor.close();
            }),
          );
        });
        if (dish.availability === 0 || cartState.submitted) add.disabled = true;
        card.append(add);
      }
      grid.append(card);
    }
    menu.append(grid);
  }
  if (account.customer_ordering !== 'DISABLED')
    content.append(
      el(
        'section',
        { class: 'card stack' },
        cartLabel,
        button(
          'Rivedi il carrello',
          () => {
            if (cartState.submitted) {
              toast('La richiesta è già stata inviata. Riprova l’invio per verificarne l’esito.');
              return;
            }
            const editor = dialog('Il tuo carrello');
            for (const line of cart) {
              const name = dishes.find((dish) => dish.id === line.dish_id)?.name ?? '';
              const quantity = field(
                `${name} · quantità`,
                'quantity',
                'number',
                String(line.quantity),
              );
              quantity.input.min = '1';
              const currentDish = dishes.find((dish) => dish.id === line.dish_id);
              quantity.input.max = String(currentDish?.availability ?? 999);
              quantity.input.addEventListener('input', () => {
                if (quantity.input.checkValidity()) {
                  line.quantity = Number(quantity.input.value);
                  updateCartLabel();
                }
              });
              quantity.input.addEventListener('change', () => quantity.input.reportValidity());
              const row = el(
                'div',
                { class: 'row' },
                quantity.root,
                button(
                  'Rimuovi',
                  () => {
                    cart.splice(cart.indexOf(line), 1);
                    row.remove();
                    updateCartLabel();
                  },
                  'quiet',
                ),
              );
              editor.append(row);
            }
          },
          'secondary',
        ),
        button(
          cartState.submitted
            ? 'Riprova invio'
            : account.customer_ordering === 'DIRECT'
              ? 'Invia ordine'
              : 'Chiedi conferma al cameriere',
          async () => {
            if (!cart.length) {
              toast('Aggiungi almeno una pietanza.', true);
              return;
            }
            if (!cartState.submitted) {
              const errors = cart.flatMap((line) => {
                const dish = dishes.find((dish) => dish.id === line.dish_id);
                return dish
                  ? validateOrderSelection(dish, line)
                  : ['Una pietanza non è più disponibile.'];
              });
              if (errors.length) {
                toast(errors.join(' '), true);
                return;
              }
              cartState.submitted = structuredClone(cart);
            }
            try {
              await rpc(
                'create_customer_order_request',
                { p_account: account.id, p_items: cartState.submitted, p_key: cartState.key },
                z.object({ status: z.string() }),
              );
            } catch (error) {
              if (
                error instanceof ApplicationError &&
                [
                  'OUT_OF_STOCK',
                  'VARIANT_SELECTION_REQUIRED',
                  'INGREDIENT_NOT_REMOVABLE',
                  'INVALID_ITEM_FIELDS',
                ].includes(error.code)
              ) {
                cartState.submitted = null;
                cartState.key = crypto.randomUUID();
              }
              await refresh();
              throw error;
            }
            cartState.lines.length = 0;
            cartState.submitted = null;
            cartState.key = crypto.randomUUID();
            toast(
              account.customer_ordering === 'DIRECT'
                ? 'Ordine inviato.'
                : 'Richiesta inviata al cameriere.',
            );
            await refresh();
          },
        ),
      ),
    );
  await ready(account);
  return content;
}

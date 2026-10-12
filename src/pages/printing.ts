import { z } from 'zod';
import { eposSuccess } from '../../shared/epos-response';
import { client, readRows, rpc, safeError } from '../api/client';
import { button, dialog, el, status, toast } from '../components/dom';
import {
  printPayloadSchema,
  printLines,
  eposDocument,
  printerEndpoint,
} from '../printing/document';
import { invoiceDocument, isPdfOutput } from '../printing/invoice';
import { safeImageUrl } from '../config/environment';
import { permittedPrintDriver } from '../services/commercial-scope';
import type { StaffContext } from './staff-context';
const jobSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  status: z.enum(['QUEUED', 'SENT', 'SUCCESS', 'FAILED', 'CANCELLED']),
  created_at: z.string(),
  payload: printPayloadSchema,
});
const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  driver: z.enum(['BROWSER', 'EPOS', 'BRIDGE']),
  endpoint: z.string().nullable(),
  active: z.boolean(),
  configuration: z.record(z.string(), z.unknown()).default({}),
});
export async function accountPrintAction(
  context: StaffContext,
  account: string,
): Promise<HTMLElement> {
  const devices = (
    await readRows('print_devices', deviceSchema, context.venue?.id, {
      active: 'true',
    })
  ).filter((device) => permittedPrintDriver(device.driver));
  return button(
    'Stampa conto',
    () => {
      const device = el(
        'select',
        { 'aria-label': 'Stampante' },
        ...devices.map((d) => el('option', { value: d.id }, d.name)),
      );
      const kind = el(
        'select',
        { 'aria-label': 'Documento' },
        el('option', { value: 'COURTESY' }, 'Conto di cortesia'),
        el('option', { value: 'RECEIPT' }, 'Ricevuta finale'),
      );
      const popup = dialog(
        'Documento non fiscale',
        el('label', {}, 'Stampante', device),
        el('label', {}, 'Documento', kind),
      );
      const key = crypto.randomUUID();
      popup.append(
        button('Accoda stampa', async () => {
          if (!device.value) {
            toast('Configura una stampante autorizzata.', true);
            return;
          }
          const result = await rpc(
            'request_account_print',
            { p_account: account, p_device: device.value, p_kind: kind.value, p_key: key },
            z.object({ id: z.uuid() }),
          );
          popup.close();
          await processPrint(context, result.id);
        }),
      );
    },
    'secondary',
  );
}
export async function processPrint(context: StaffContext, id: string): Promise<void> {
  const result = await rpc(
    'claim_print_job',
    { p_job: id },
    z.object({
      job: z.object({ id: z.uuid(), lease_token: z.uuid(), payload: printPayloadSchema }),
      device: deviceSchema,
    }),
  );
  const { job, device } = result;
  const finish = async (success: boolean) => {
    await rpc(
      'finish_print_job',
      {
        p_job: job.id,
        p_lease: job.lease_token,
        p_success: success,
        p_error: success ? null : 'PRINT_OUTCOME_UNKNOWN',
      },
      z.null(),
    );
    await context.refresh?.();
  };
  // This also guards jobs created before the edition was restricted: callers
  // must not dispatch a historical EPOS/BRIDGE job through processPrint().
  if (!permittedPrintDriver(device.driver)) {
    await finish(false);
    toast('La stampa su questo dispositivo non è inclusa in Plateform CORE.', true);
    return;
  }
  if (device.driver === 'BROWSER') {
    const logo = safeImageUrl(job.payload.logo);
    const pdf = isPdfOutput(device.configuration);
    const preview = pdf
      ? invoiceDocument(job.payload, logo)
      : el('section', { class: 'print-document' });
    if (!pdf) {
      if (logo)
        preview.append(
          el('img', { src: logo, alt: job.payload.restaurant, class: 'receipt-logo' }),
        );
      preview.append(el('pre', {}, printLines(job.payload).join('\n')));
    }
    const popup = dialog(
      pdf ? 'Anteprima PDF' : 'Anteprima stampa',
      preview,
      el(
        'p',
        {},
        pdf
          ? 'Nel dialogo di stampa del browser scegli “Salva come PDF”. Il documento resta non fiscale.'
          : 'Dopo la stampa verifica il documento fisico e registra l’esito.',
      ),
    );
    popup.append(
      button(pdf ? 'Stampa / salva PDF' : 'Apri stampa browser', () => window.print()),
      button(pdf ? 'PDF salvato e verificato' : 'Documento stampato e verificato', async () => {
        await finish(true);
        popup.close();
      }),
      button(
        'Esito incerto o stampa fallita',
        async () => {
          await finish(false);
          popup.close();
        },
        'secondary',
      ),
    );
    return;
  }
  try {
    if (!device.endpoint) throw new Error('INVALID_PRINT_ENDPOINT');
    const endpoint = printerEndpoint(device.endpoint, device.driver);
    if (device.driver === 'BRIDGE') {
      const { data: signed, error: signError } = await client().functions.invoke(
        'print-authorization',
        { body: { job_id: job.id, lease_id: job.lease_token } },
      );
      if (signError) throw safeError(signError);
      const signedJob = z
        .object({
          document: z.string().max(65536),
          authorization: z.object({
            payload: z.string().max(4096),
            signature: z.string().length(86),
          }),
        })
        .parse(signed);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedJob),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      const receipt = z
        .object({ job_id: z.uuid(), success: z.boolean() })
        .parse(await response.json());
      if (!response.ok || receipt.job_id !== job.id || !receipt.success)
        throw new Error('PRINT_OUTCOME_UNKNOWN');
    } else {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
        body: eposDocument(job.payload),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      const raw = await response.text();
      if (raw.length > 32768 || !response.ok) throw new Error('PRINT_OUTCOME_UNKNOWN');
      if (!eposSuccess(raw)) throw new Error('PRINT_OUTCOME_UNKNOWN');
    }
    await finish(true);
    toast('Stampante: esito positivo ricevuto.');
  } catch {
    await finish(false);
    dialog(
      'Verifica la stampante',
      el(
        'p',
        {},
        'L’esito non è confermato. Controlla carta, rete e documento fisico prima di ristampare.',
      ),
    );
  }
}
export async function printingPage(context: StaffContext): Promise<HTMLElement> {
  if (!context.venue) return el('p', {}, 'Seleziona una sede autorizzata.');
  const list = el('div', { class: 'stack' });
  const filter = el(
    'select',
    { 'aria-label': 'Stato delle stampe' },
    el('option', { value: '' }, 'Tutti gli stati'),
    ...['QUEUED', 'SENT', 'SUCCESS', 'FAILED', 'CANCELLED'].map((value) =>
      el('option', { value }, value),
    ),
  );
  let cursor: { at: string; id: string } | null = null;
  let revision = 0;
  const more = button('Carica altre stampe', () => load(true), 'secondary');
  more.hidden = true;
  async function load(append = false): Promise<void> {
    const current = ++revision;
    if (!append) cursor = null;
    const data = await rpc(
      'get_print_jobs',
      {
        p_venue: context.venue!.id,
        p_after_at: cursor?.at ?? null,
        p_after_id: cursor?.id ?? null,
        p_status: filter.value || null,
        p_limit: 50,
      },
      z.object({ items: z.array(jobSchema), has_more: z.boolean() }),
    );
    if (current !== revision) return;
    if (!append) list.replaceChildren();
    for (const job of data.items) {
      const row = el(
        'article',
        { class: 'card stack' },
        el(
          'div',
          { class: 'row between' },
          el('strong', {}, `${job.kind} · ${job.payload.table}`),
          status(job.status),
        ),
        el('p', { class: 'muted' }, new Date(job.created_at).toLocaleString('it-IT')),
      );
      if (job.status === 'QUEUED')
        row.append(
          el(
            'div',
            { class: 'row' },
            button('Invia alla stampante', () => processPrint(context, job.id)),
            button(
              'Annulla stampa in coda',
              () => {
                const popup = dialog(
                  'Annulla questa stampa',
                  el('p', {}, 'Il documento non è ancora stato inviato alla stampante.'),
                );
                popup.append(
                  button('Conferma annullamento', async () => {
                    await rpc('cancel_print_job', { p_job: job.id }, z.null());
                    popup.close();
                    await load();
                  }),
                );
              },
              'secondary',
            ),
          ),
        );
      else if (['SENT', 'FAILED', 'SUCCESS'].includes(job.status))
        row.append(
          button(
            'Verifica e ristampa',
            () => {
              const check = el('input', { type: 'checkbox', required: '' });
              const popup = dialog(
                'Conferma ristampa',
                el(
                  'label',
                  {},
                  check,
                  'Ho verificato il documento fisico e accetto la possibile stampa duplicata.',
                ),
              );
              const key = crypto.randomUUID();
              popup.append(
                button('Accoda ristampa', async () => {
                  if (!check.reportValidity()) return;
                  const retry = await rpc(
                    'retry_print_job',
                    { p_job: job.id, p_confirm_duplicate_risk: true, p_key: key },
                    z.object({ id: z.uuid() }),
                  );
                  popup.close();
                  await processPrint(context, retry.id);
                }),
              );
            },
            'secondary',
          ),
        );
      list.append(row);
    }
    if (!append && !data.items.length)
      list.append(el('p', {}, 'Nessuna stampa in questa selezione.'));
    const last = data.items.at(-1);
    cursor = last ? { at: last.created_at, id: last.id } : null;
    more.hidden = !data.has_more;
  }
  const root = el(
    'div',
    { class: 'stack' },
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'Stato', filter),
      button('Aggiorna stampe', () => load(), 'secondary'),
    ),
    list,
    more,
  );
  filter.addEventListener('change', () => {
    void load().catch((error) => {
      toast(String(error instanceof Error ? error.message : 'Aggiornamento non completato.'), true);
    });
  });
  context.refresh = () => load();
  await load();
  return root;
}

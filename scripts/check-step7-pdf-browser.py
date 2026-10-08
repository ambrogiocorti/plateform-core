#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROMIUM = Path('/usr/bin/chromium')


def run(*args: str) -> str:
    return subprocess.check_output(list(args), text=True, stderr=subprocess.STDOUT)


def compile_renderer(temp: Path) -> str:
    source = temp / 'src'
    (source / 'printing').mkdir(parents=True)
    (source / 'components').mkdir(parents=True)
    (source / 'printing' / 'invoice.ts').write_text(
        (ROOT / 'src' / 'printing' / 'invoice.ts').read_text(encoding='utf-8'),
        encoding='utf-8',
    )
    (source / 'components' / 'dom.ts').write_text(
        '''export type Child = Node | string | number | null | undefined | false;
export function el(tag: string, attributes: Record<string,string> = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name,value] of Object.entries(attributes)) element.setAttribute(name,value);
  for (const child of children) if (child !== null && child !== undefined && child !== false)
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}
''',
        encoding='utf-8',
    )
    (source / 'printing' / 'document.ts').write_text(
        '''export interface PrintPayload {
  at:string; timezone?:string; legal_name?:string; restaurant:string; venue?:string; address?:string;
  account:string; table:string;
  lines:Array<{quantity:number;name:string;unit_price_cents?:number;discount_cents?:number;total_cents?:number}>;
  balance?:{discount_cents:number;total_cents:number;paid_cents?:number;remaining_cents?:number};
  payments?:Array<{method:string;amount_cents:number;tip_cents?:number}>;
  refunds?:Array<{method:string;amount_cents:number}>;
}
''',
        encoding='utf-8',
    )
    out = temp / 'out'
    completed = subprocess.run(
        [
            'tsc', '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler',
            '--skipLibCheck', '--lib', 'ES2022,DOM', '--outDir', str(out),
            str(source / 'printing' / 'invoice.ts'), str(source / 'components' / 'dom.ts'),
            str(source / 'printing' / 'document.ts'),
        ],
        capture_output=True,
        text=True,
        cwd='/',
    )
    if completed.returncode:
        raise RuntimeError(f"TypeScript transpile failed: {completed.stdout}{completed.stderr}")
    dom = (out / 'components' / 'dom.js').read_text(encoding='utf-8')
    invoice = (out / 'printing' / 'invoice.js').read_text(encoding='utf-8')
    dom = re.sub(r'\bexport\s+', '', dom)
    invoice = re.sub(
        r"import\s*\{\s*el\s*\}\s*from\s*['\"]\.\./components/dom['\"];?",
        '',
        invoice,
    )
    invoice = re.sub(r'\bexport\s+', '', invoice)
    return f"{dom}\n{invoice}\nwindow.invoiceDocument = invoiceDocument;"


def main() -> int:
    if not CHROMIUM.exists():
        print(json.dumps({'status': 'BLOCKED_ENVIRONMENT', 'reason': 'chromium_missing'}))
        return 2
    if not shutil_which('tsc') or not shutil_which('pdftotext') or not shutil_which('pdfinfo'):
        print(json.dumps({'status': 'BLOCKED_ENVIRONMENT', 'reason': 'tsc_or_pdf_tools_missing'}))
        return 2

    payload = {
        'at': '2026-10-05T18:30:00+02:00',
        'timezone': 'Europe/Rome',
        'legal_name': 'Plateform Demo SRL',
        'restaurant': 'Plateform Demo',
        'venue': 'Sede collaudo',
        'address': 'Via Test 1, Milano',
        'account': 'CONTO-TEST',
        'table': '12',
        'lines': [
            {'quantity': 2, 'name': 'Risotto alla milanese', 'unit_price_cents': 1800, 'discount_cents': 200, 'total_cents': 3400},
            {'quantity': 1, 'name': 'Acqua naturale', 'unit_price_cents': 300, 'discount_cents': 0, 'total_cents': 300},
        ],
        'balance': {'discount_cents': 200, 'total_cents': 3700, 'paid_cents': 3700, 'remaining_cents': 0},
        'payments': [{'method': 'CASH', 'amount_cents': 3700, 'tip_cents': 200}],
        'refunds': [{'method': 'CASH', 'amount_cents': 500}],
    }

    # The temporary directory is deliberately outside ROOT. Never chdir into it, so cleanup
    # cannot invalidate or delete the project working directory.
    with tempfile.TemporaryDirectory(prefix='plateform-step7-pdf-', dir='/mnt/data') as raw_temp:
        temp = Path(raw_temp)
        javascript = compile_renderer(temp)
        css = (ROOT / 'styles' / 'staff.css').read_text(encoding='utf-8')
        pdf = temp / 'plateform-invoice.pdf'
        html = f'''<!doctype html><html><head><meta charset="utf-8"><style>{css}</style></head><body>
<dialog open aria-label="Anteprima PDF"><section id="mount"></section></dialog>
<script>{javascript}</script>
<script>
const root = document.querySelector('#mount');
const doc = window.invoiceDocument({json.dumps(payload, ensure_ascii=False)});
root.replaceWith(doc);
</script></body></html>'''

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=str(CHROMIUM),
                headless=True,
                args=['--no-sandbox'],
            )
            page = browser.new_page(viewport={'width': 1200, 'height': 1600})
            page.set_content(html, wait_until='load')
            dom_footer = page.locator('.invoice-footer').inner_text().strip()
            page.pdf(
                path=str(pdf),
                format='A4',
                print_background=True,
                margin={'top': '10mm', 'right': '10mm', 'bottom': '10mm', 'left': '10mm'},
            )
            browser.close()

        extracted = run('pdftotext', str(pdf), '-')
        info = run('pdfinfo', str(pdf))
        pages = int(re.search(r'^Pages:\s+(\d+)', info, re.MULTILINE).group(1))
        size = re.search(r'^Page size:\s+([0-9.]+) x ([0-9.]+) pts', info, re.MULTILINE)
        width_mm = float(size.group(1)) * 25.4 / 72
        height_mm = float(size.group(2)) * 25.4 / 72

        normalized = ' '.join(extracted.split())
        checks = {
            'single_page': pages == 1,
            'a4_width': abs(width_mm - 210.0) < 1.0,
            'a4_height': abs(height_mm - 297.0) < 1.0,
            'non_fiscal': 'NON FISCALE' in normalized,
            'account': 'CONTO-TEST' in normalized,
            'table': 'Tavolo: 12' in normalized,
            'total': 'Totale' in normalized and ('37,00' in normalized or '37,00 €' in normalized),
            'payment': 'CASH' in normalized and 'Pagamenti e rimborsi' in normalized,
            'refund': 'Rimborso CASH' in normalized,
            'footer': 'Documento non fiscale' in normalized and 'Sistema di Interscambio' in normalized,
            'dom_footer_matches_production_copy': 'Documento non fiscale' in dom_footer and 'Sistema di Interscambio' in dom_footer,
        }
        status = 'PASSED' if all(checks.values()) else 'FAILED'
        result = {
            'date': '2026-10-05',
            'step': 7,
            'status': status,
            'renderer': 'src/printing/invoice.ts',
            'print_structure': 'dialog[open] > .invoice-document',
            'css': 'styles/staff.css',
            'browser': str(CHROMIUM),
            'pages': pages,
            'page_mm': {'width': round(width_mm, 2), 'height': round(height_mm, 2)},
            'checks': checks,
        }
        print(json.dumps(result, ensure_ascii=False))
        if status != 'PASSED':
            print('PDF_TEXT=' + normalized[:3000])
            return 1
        return 0


def shutil_which(command: str) -> str | None:
    import shutil
    return shutil.which(command)


if __name__ == '__main__':
    raise SystemExit(main())

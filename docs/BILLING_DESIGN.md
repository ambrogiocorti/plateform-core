# Addebiti, divisioni e pagamenti misti

Stato: registro per unità, pagamenti misti per importo/prodotti e sconti implementati
con test locali. Divisione equa persistente, trasferimenti e unioni ancora in corso.

## Separazione delle responsabilità

La comanda (`orders` / `order_items`) conserva preparazione, destinazione, ingredienti,
varianti e prezzi storici. L'addebito usa unità contabili collegate alla riga originale.
Spostare un addebito tra conti non genera una nuova comanda o una seconda preparazione.

Ogni unità conserva prezzo storico, sconto attribuito, conto corrente e collegamento
alla riga. Le allocazioni dei pagamenti sono importi in centesimi collegati alle unità.
Un pagamento per importo può coprire parte di un'unità. Un successivo pagamento per
prodotti copre solo il residuo, con prezzo verificato nuovamente dal server.

## Invarianti

- Il totale delle allocazioni di un pagamento attivo coincide con il suo importo,
  esclusa la mancia. Le mance rimangono nel registro separato.
- Importi completati e riservati non superano il netto dell'unità.
- Un pagamento fallito o stornato libera le allocazioni; lo storico resta leggibile.
- Il rimborso conserva il pagamento originale e produce un movimento negativo nel
  giornale contabile. Non equivale da solo a una modifica della comanda.
- Gli sconti si ripartiscono con quozienti interi e distribuzione dei resti maggiori,
  ordinati per ID in caso di parità. Nessun centesimo viene perso.
- Importi già regolati restano protetti. Le correzioni economiche di prodotti già
  saldati richiedono il workflow esplicito di rettifica e rimborso.
- Requisito dei trasferimenti e delle unioni ancora da implementare: bloccare i conti
  in ordine stabile e conservare origine,
  operatore, motivazione e collegamenti nei movimenti auditati.

## Migrazione e verifiche

I dati esistenti richiedono una ricostruzione delle allocazioni: selezioni per prodotti
prima, importi liberi dopo, rispettando le selezioni già registrate. Una discrepanza
interrompe la migrazione e richiede riconciliazione; non viene cancellata o compensata
silenziosamente. I test devono includere sconti con resti, pagamento misto, selezioni
concorrenti, retry, storno, divisione e unione con pagamenti già presenti.

Verificati in `tests/database/billing.test.ts`: sette casi di calcolo, approvazione,
pagamenti misti, fallimenti/retry e migrazione di incassi esistenti. I contratti browser
dei prodotti con sconto e dell'anteprima percentuale sono in `tests/e2e/accounts.spec.ts`.

Il registro di copertura in `IMPLEMENTATION_STATUS.md` resta autoritativo sullo stato
effettivamente verificato. Concorrenza su connessioni separate e provider richiedono
le prove Supabase e sandbox esterne previste dal master.

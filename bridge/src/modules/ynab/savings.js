import { ynabFetch } from "./client.js";
import { muToUnits } from "./utils.js";

/**
 * Savings rate "de comportamiento" (sept 2026).
 *
 * Antes se sumaban todas las transacciones sin transferencia: los "Reconciliation Balance Adjustment"
 * de las cuentas de seguimiento entraban como ingreso o gasto y el resultado dependía del mercado,
 * no del gasto. Ahora:
 *   - ingresos = entradas a "Inflow: Ready to Assign" (nómina, transferencias de terceros, intereses)
 *   - gasto    = actividad neta de categorías del presupuesto (gastos menos reembolsos)
 *   - fuera siempre: transferencias entre cuentas, reconciliaciones, transacciones sin categoría
 *     (cuentas de seguimiento) y los grupos nombrados en YNAB_SAVINGS_EXCLUDE_GROUPS
 *   - los grupos de YNAB_EARMARKED_GROUPS se separan: se da la tasa con y sin ellos.
 */

const RECON = "reconciliation balance adjustment";

function envList(name) {
  const v = process.env[name];
  if (!v || !v.trim()) return [];
  return v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function defaultGroupConfig() {
  return {
    excludeGroups: envList("YNAB_SAVINGS_EXCLUDE_GROUPS"),
    earmarkedGroups: envList("YNAB_EARMARKED_GROUPS")
  };
}

/** Mapa category_id → { name, group } a partir de la respuesta de /categories. */
export function buildCategoryIndex(categoryGroups = []) {
  const idx = new Map();
  for (const g of categoryGroups) {
    for (const c of g.categories || []) idx.set(c.id, { name: c.name, group: g.name });
  }
  return idx;
}

/** Aplana splits: cada línea con su categoría/transferencia propias. */
export function flattenTransactions(transactions = []) {
  const out = [];
  for (const t of transactions) {
    if (t.deleted) continue;
    const subs = (t.subtransactions || []).filter((s) => !s.deleted);
    if (subs.length) {
      for (const s of subs) {
        out.push({ date: t.date, amount: s.amount, category_id: s.category_id, transfer_account_id: s.transfer_account_id || t.transfer_account_id, payee_name: s.payee_name || t.payee_name });
      }
    } else {
      out.push({ date: t.date, amount: t.amount, category_id: t.category_id, transfer_account_id: t.transfer_account_id, payee_name: t.payee_name });
    }
  }
  return out;
}

/**
 * @param {{ transactions: object[], categoryIndex: Map<string,{name:string,group:string}>, since: string, until: string, excludeGroups?: string[], earmarkedGroups?: string[] }} p
 */
export function computeSavingsRate({ transactions, categoryIndex, since, until, excludeGroups, earmarkedGroups }) {
  const cfg = defaultGroupConfig();
  const excl = (excludeGroups || cfg.excludeGroups).map((s) => s.toLowerCase());
  const ear = (earmarkedGroups || cfg.earmarkedGroups).map((s) => s.toLowerCase());

  let income = 0;
  let spendAll = 0; // positivo = gasto neto
  let spendEarmarked = 0;
  const ignored = { transfers: 0, reconciliations: 0, uncategorized: 0, excluded_groups: 0 };

  for (const t of flattenTransactions(transactions)) {
    if (t.date < since || t.date > until) continue;
    if (t.transfer_account_id) { ignored.transfers += t.amount; continue; }
    if ((t.payee_name || "").toLowerCase().includes(RECON)) { ignored.reconciliations += t.amount; continue; }
    const cat = t.category_id ? categoryIndex.get(t.category_id) : null;
    if (!cat) { ignored.uncategorized += t.amount; continue; }
    const group = (cat.group || "").toLowerCase();
    if (/^inflow/i.test(cat.name) || group === "internal master category") { income += t.amount; continue; }
    if (excl.includes(group)) { ignored.excluded_groups += t.amount; continue; }
    spendAll += -t.amount;
    if (ear.includes(group)) spendEarmarked += -t.amount;
  }

  const spendBehaviour = spendAll - spendEarmarked;
  // Por debajo de este ingreso (p. ej. un abono suelto antes de que entre la nómina) la tasa no significa nada.
  const minIncome = Number(process.env.YNAB_SAVINGS_MIN_INCOME || 500) * 1000;
  const calculable = income >= minIncome;
  const rate = (inc, spend) => (calculable ? Math.round(((inc - spend) / inc) * 10000) / 100 : null);

  return {
    since_date: since,
    until_date: until,
    method: "ready_to_assign_vs_category_activity",
    income: muToUnits(income),
    expenses: muToUnits(spendAll),
    expenses_earmarked: muToUnits(spendEarmarked),
    expenses_excluding_earmarked: muToUnits(spendBehaviour),
    savings: muToUnits(income - spendAll),
    savings_rate: rate(income, spendAll),
    savings_rate_excluding_earmarked: rate(income, spendBehaviour),
    excluded: {
      transfers: muToUnits(ignored.transfers),
      reconciliations: muToUnits(ignored.reconciliations),
      uncategorized: muToUnits(ignored.uncategorized),
      excluded_groups: muToUnits(ignored.excluded_groups)
    },
    groups: { excluded: excl, earmarked: ear },
    note: calculable ? undefined : "Ingresos (Ready to Assign) por debajo del mínimo en el periodo: la tasa no es calculable (¿aún no ha entrado la nómina?)."
  };
}

/** Descarga transacciones y categorías y calcula. */
export async function fetchSavingsRate({ budget_id, since_date, until_date, excludeGroups, earmarkedGroups }) {
  const params = new URLSearchParams();
  params.set("since_date", since_date);
  const [tx, cats] = await Promise.all([
    ynabFetch(`/budgets/${budget_id}/transactions?${params}`),
    ynabFetch(`/budgets/${budget_id}/categories`)
  ]);
  return computeSavingsRate({
    transactions: tx?.data?.transactions ?? [],
    categoryIndex: buildCategoryIndex(cats?.data?.category_groups ?? []),
    since: since_date,
    until: until_date,
    excludeGroups,
    earmarkedGroups
  });
}

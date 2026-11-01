import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSavingsRate, buildCategoryIndex, flattenTransactions } from "./savings.js";

const groups = [
  { name: "Internal Master Category", categories: [{ id: "rta", name: "Inflow: Ready to Assign" }] },
  { name: "CASA", categories: [{ id: "rent", name: "🏠 Alquiler" }] },
  { name: "NECESIDADES", categories: [{ id: "vet", name: "😽😾 Alex y Noa" }] },
  { name: "FONDO", categories: [{ id: "piso", name: "🏠 Compra de vivienda - Puerto Alto" }] },
  { name: "RESERVA", categories: [{ id: "inv", name: "📈 Inversiones" }] }
];
const idx = buildCategoryIndex(groups);
const mu = (e) => Math.round(e * 1000);

test("agosto: nómina + Noa + intereses vs gasto; entrada del piso aparte", () => {
  const tx = [
    { date: "2026-08-27", amount: mu(3372.16), category_id: "rta", payee_name: "Nómina" },
    { date: "2026-08-28", amount: mu(800), category_id: "rta", payee_name: "Noa" },
    { date: "2026-08-01", amount: mu(119.18), category_id: "rta", payee_name: "Intereses" },
    { date: "2026-08-03", amount: mu(-3016.78), category_id: "rent", payee_name: "Varios" },
    { date: "2026-08-06", amount: mu(-4950), category_id: "piso", payee_name: "Promotora Norte" }
  ];
  const r = computeSavingsRate({ transactions: tx, categoryIndex: idx, since: "2026-08-01", until: "2026-08-31", excludeGroups: ["RESERVA"], earmarkedGroups: ["FONDO"] });
  assert.equal(r.income, 4291.34);
  assert.equal(r.expenses_excluding_earmarked, 3016.78);
  assert.equal(r.savings_rate_excluding_earmarked, 29.7);
  assert.equal(r.savings_rate, -85.65);
});

test("septiembre: reconciliaciones, transferencias y ahorro no cuentan", () => {
  const tx = [
    { date: "2026-09-15", amount: mu(3312.28), category_id: null, payee_name: "Reconciliation Balance Adjustment" },
    { date: "2026-09-15", amount: mu(-1250.59), category_id: null, payee_name: "Reconciliation Balance Adjustment" },
    { date: "2026-09-20", amount: mu(-50), category_id: null, transfer_account_id: "tr", payee_name: "Transfer : TR cartera" },
    { date: "2026-09-10", amount: mu(136.45), category_id: "inv", payee_name: "Venta" },
    { date: "2026-09-03", amount: mu(-900), category_id: "rent", payee_name: "Alquiler" },
    { date: "2026-09-16", amount: mu(-600), category_id: "vet", payee_name: "Clinica Vet" },
    { date: "2026-09-17", amount: mu(20), category_id: "vet", payee_name: "Reembolso" },
    { date: "2026-09-28", amount: mu(3372), category_id: "rta", payee_name: "Nómina" }
  ];
  const r = computeSavingsRate({ transactions: tx, categoryIndex: idx, since: "2026-09-01", until: "2026-09-30", excludeGroups: ["RESERVA"], earmarkedGroups: ["FONDO"] });
  assert.equal(r.income, 3372);
  assert.equal(r.expenses, 1480);
  assert.equal(r.excluded.reconciliations, 2061.69);
  assert.equal(r.excluded.transfers, -50);
  assert.equal(r.excluded.excluded_groups, 136.45);
  assert.equal(r.savings_rate, 56.11);
});

test("abono suelto sin nómina: tasa null con nota", () => {
  const r = computeSavingsRate({
    transactions: [{ date: "2026-09-01", amount: mu(23.72), category_id: "rta" }, { date: "2026-09-03", amount: mu(-900), category_id: "rent" }],
    categoryIndex: idx, since: "2026-09-01", until: "2026-09-27"
  });
  assert.equal(r.income, 23.72);
  assert.equal(r.savings_rate, null);
  assert.equal(r.savings_rate_excluding_earmarked, null);
});

test("sin nómina en el periodo: tasa null con nota", () => {
  const r = computeSavingsRate({
    transactions: [{ date: "2026-09-03", amount: mu(-900), category_id: "rent" }],
    categoryIndex: idx, since: "2026-09-01", until: "2026-09-27"
  });
  assert.equal(r.savings_rate, null);
  assert.ok(r.note);
});

test("splits: cada línea cuenta con su categoría", () => {
  const flat = flattenTransactions([{ date: "2026-09-01", amount: mu(-100), category_id: null, subtransactions: [
    { amount: mu(-60), category_id: "rent" }, { amount: mu(-40), category_id: "piso" }
  ] }]);
  assert.equal(flat.length, 2);
  const r = computeSavingsRate({ transactions: [{ date: "2026-09-01", amount: mu(-100), category_id: null, subtransactions: [
    { amount: mu(-60), category_id: "rent" }, { amount: mu(-40), category_id: "piso" }] },
    { date: "2026-09-28", amount: mu(1000), category_id: "rta" }], categoryIndex: idx, since: "2026-09-01", until: "2026-09-30", excludeGroups: ["RESERVA"], earmarkedGroups: ["FONDO"] });
  assert.equal(r.expenses_earmarked, 40);
  assert.equal(r.expenses_excluding_earmarked, 60);
});

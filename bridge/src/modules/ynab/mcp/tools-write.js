import { z } from "zod";
import { ok, fail } from "./helpers.js";
import { ynabFetch, ynabPost, ynabPatch, ynabPut, ynabDelete } from "../client.js";
import { normalizeMonth, muToUnits, getPeriodKey, mapTransaction, mapScheduledTransaction } from "../utils.js";

export function register(mcp) {
  mcp.registerTool("create_transaction", {
    title: "Create Transaction",
    description: "Create one or more transactions. Body follows YNAB API format: { transaction: {...} } or { transactions: [...] }. Amounts in milliunits (1€ = 1000). Required fields: account_id, date (YYYY-MM-DD), amount.",
    inputSchema: z.object({
      budget_id: z.string(),
      body: z.any().describe("YNAB transaction body: { transaction: { account_id, date, amount, ... } } or { transactions: [...] }")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async ({ budget_id, body }) => {
    try {
      const data = await ynabPost(`/budgets/${budget_id}/transactions`, body);
      const result = {};
      if (data?.data?.transaction) result.transaction = mapTransaction(data.data.transaction);
      if (data?.data?.transactions) result.transactions = data.data.transactions.map(mapTransaction);
      if (data?.data?.duplicate_import_ids) result.duplicate_import_ids = data.data.duplicate_import_ids;
      return ok(result);
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("update_transactions", {
    title: "Update Transactions (bulk)",
    description: "Update multiple transactions. Body: { transactions: [{ id, ...fields }] }",
    inputSchema: z.object({
      budget_id: z.string(),
      body: z.any().describe("{ transactions: [{ id, account_id, date, amount, ... }] }")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async ({ budget_id, body }) => {
    try {
      const data = await ynabPatch(`/budgets/${budget_id}/transactions`, body);
      const result = {};
      if (data?.data?.transaction) result.transaction = mapTransaction(data.data.transaction);
      if (data?.data?.transactions) result.transactions = data.data.transactions.map(mapTransaction);
      return ok(result);
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("update_transaction", {
    title: "Update Transaction",
    description: "Update a single transaction by ID. Body: { transaction: { ...fields } }",
    inputSchema: z.object({
      budget_id: z.string(),
      transaction_id: z.string(),
      body: z.any().describe("{ transaction: { account_id, date, amount, ... } }")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async ({ budget_id, transaction_id, body }) => {
    try {
      const data = await ynabPut(`/budgets/${budget_id}/transactions/${transaction_id}`, body);
      return ok({ transaction: mapTransaction(data?.data?.transaction) });
    } catch (e) { return fail(e); }
  });

  // ── Scheduled Transactions ───────────────────────────────────────────────

  mcp.registerTool("create_scheduled_transaction", {
    title: "Create Scheduled Transaction",
    description: "Create a scheduled transaction. Body: { scheduled_transaction: { account_id, date_first, frequency, amount, ... } }",
    inputSchema: z.object({
      budget_id: z.string(),
      body: z.any().describe("{ scheduled_transaction: { account_id, date_first, frequency, amount, ... } }")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async ({ budget_id, body }) => {
    try {
      const data = await ynabPost(`/budgets/${budget_id}/scheduled_transactions`, body);
      return ok({ scheduled_transaction: mapScheduledTransaction(data?.data?.scheduled_transaction) });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("update_scheduled_transaction", {
    title: "Update Scheduled Transaction",
    description: "Update a scheduled transaction. Body: { scheduled_transaction: { ...fields } }",
    inputSchema: z.object({
      budget_id: z.string(),
      scheduled_transaction_id: z.string(),
      body: z.any().describe("{ scheduled_transaction: { ...fields } }")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async ({ budget_id, scheduled_transaction_id, body }) => {
    try {
      const data = await ynabPut(`/budgets/${budget_id}/scheduled_transactions/${scheduled_transaction_id}`, body);
      return ok({ scheduled_transaction: mapScheduledTransaction(data?.data?.scheduled_transaction) });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("delete_scheduled_transaction", {
    title: "Delete Scheduled Transaction",
    description: "Delete a scheduled transaction by ID",
    inputSchema: z.object({ budget_id: z.string(), scheduled_transaction_id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ budget_id, scheduled_transaction_id }) => {
    try {
      const data = await ynabDelete(`/budgets/${budget_id}/scheduled_transactions/${scheduled_transaction_id}`);
      return ok({ scheduled_transaction: mapScheduledTransaction(data?.data?.scheduled_transaction) });
    } catch (e) { return fail(e); }
  });

  // ── Savings Rate ─────────────────────────────────────────────────────────

  mcp.registerTool("update_category_budget", {
    title: "Update Category Budget",
    description: "Change the budgeted amount for a category in a specific month. Amount in milliunits (1€ = 1000). Use when the user says 'move budget from X to Y' or 'set Restaurants budget to 200€'.",
    inputSchema: z.object({
      budget_id: z.string(),
      category_id: z.string(),
      month: z.string().optional().describe("YYYY-MM or 'current'"),
      budgeted: z.number().describe("New budgeted amount in milliunits (1€ = 1000)")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async ({ budget_id, category_id, month, budgeted }) => {
    try {
      const mth = normalizeMonth(month || "current");
      const data = await ynabPatch(`/budgets/${budget_id}/months/${mth}/categories/${category_id}`, {
        category: { budgeted: Number(budgeted) }
      });
      const c = data?.data?.category;
      return ok({
        category: { id: c.id, name: c.name, month: mth,
          budgeted: muToUnits(c.budgeted), activity: muToUnits(c.activity), balance: muToUnits(c.balance) }
      });
    } catch (e) { return fail(e); }
  });

  // ── Top Merchants ────────────────────────────────────────────────────────
}

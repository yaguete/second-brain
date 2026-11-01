import { z } from "zod";
import { ok, fail } from "./helpers.js";
import { ynabFetch, ynabPost, ynabPatch, ynabPut, ynabDelete } from "../client.js";
import { normalizeMonth, muToUnits, getPeriodKey, mapTransaction, mapScheduledTransaction } from "../utils.js";

export function register(mcp) {
  mcp.registerTool("list_budgets", {
    title: "List Budgets",
    description: "List all YNAB budgets (id and name)",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try {
      const data = await ynabFetch("/budgets");
      const budgets = data?.data?.budgets?.map(b => ({ id: b.id, name: b.name })) ?? [];
      return ok({ budgets });
    } catch (e) { return fail(e); }
  });

  // ── Month Summary ────────────────────────────────────────────────────────

  mcp.registerTool("get_month_summary", {
    title: "Month Summary",
    description: "Get budget totals for a month (budgeted, activity, balance)",
    inputSchema: z.object({
      budget_id: z.string().describe("Budget ID"),
      month: z.string().optional().describe("Month in YYYY-MM format, or 'current'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month }) => {
    try {
      const mth = normalizeMonth(month || "current");
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const monthData = data?.data?.month;
      const totalBudgeted = monthData?.categories?.reduce((s, c) => s + (c.budgeted || 0), 0) || 0;
      const totalActivity = monthData?.categories?.reduce((s, c) => s + (c.activity || 0), 0) || 0;
      const totalBalance = monthData?.categories?.reduce((s, c) => s + (c.balance || 0), 0) || 0;
      return ok({
        month: monthData?.month,
        totals: { budgeted: muToUnits(totalBudgeted), activity: muToUnits(totalActivity), balance: muToUnits(totalBalance) }
      });
    } catch (e) { return fail(e); }
  });

  // ── Spending by Category ─────────────────────────────────────────────────

  mcp.registerTool("get_spending_by_category", {
    title: "Spending by Category",
    description: "Top categories by spending for a given month",
    inputSchema: z.object({
      budget_id: z.string(),
      month: z.string().optional().describe("YYYY-MM or 'current'"),
      top: z.number().optional().describe("Max categories to return (default 50)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month, top }) => {
    try {
      const mth = normalizeMonth(month || "current");
      const limit = top || 50;
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const cats = data?.data?.month?.categories ?? [];
      const spending = cats
        .map(c => ({ id: c.id, name: c.name, group: c.category_group_name, activity: muToUnits(c.activity || 0) }))
        .filter(c => c.activity < 0)
        .sort((a, b) => a.activity - b.activity)
        .slice(0, limit);
      return ok({ month: data?.data?.month?.month, spending });
    } catch (e) { return fail(e); }
  });

  // ── Payee Breakdown ──────────────────────────────────────────────────────

  mcp.registerTool("get_payee_breakdown", {
    title: "Payee Breakdown",
    description: "Aggregated spending by payee within a category",
    inputSchema: z.object({
      budget_id: z.string(),
      category_id: z.string(),
      payee_id: z.string().optional(),
      since_date: z.string().optional().describe("YYYY-MM-DD"),
      until_date: z.string().optional().describe("YYYY-MM-DD"),
      top: z.number().optional().describe("Max payees (default 50)"),
      type: z.enum(["outflow", "inflow", "all"]).optional().describe("Default: outflow")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, category_id, payee_id, since_date, until_date, top: topN, type: txType }) => {
    try {
      const top = topN || 50;
      const type = txType || "outflow";
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";
      const data = await ynabFetch(`/budgets/${budget_id}/categories/${category_id}/transactions${qs}`);
      let txns = data?.data?.transactions ?? [];
      if (until_date) txns = txns.filter(t => t.date <= until_date);
      if (payee_id) txns = txns.filter(t => t.payee_id === payee_id);
      if (type === "outflow") txns = txns.filter(t => t.amount < 0);
      else if (type === "inflow") txns = txns.filter(t => t.amount > 0);
      const byPayee = new Map();
      for (const t of txns) {
        const key = t.payee_id || "_no_payee";
        const ex = byPayee.get(key);
        if (ex) { ex.total += t.amount; ex.count += 1; }
        else byPayee.set(key, { payee_id: t.payee_id, payee_name: t.payee_name || "(Sin payee)", total: t.amount, count: 1 });
      }
      const breakdown = Array.from(byPayee.values())
        .sort((a, b) => type === "outflow" ? a.total - b.total : b.total - a.total)
        .slice(0, top)
        .map(p => ({ payee_id: p.payee_id, payee_name: p.payee_name, total: muToUnits(p.total), count: p.count }));
      const grand_total = txns.reduce((s, t) => s + t.amount, 0);
      return ok({ category_id, type, transaction_count: txns.length, grand_total: muToUnits(grand_total), breakdown });
    } catch (e) { return fail(e); }
  });

  // ── Category Breakdown ───────────────────────────────────────────────────

  mcp.registerTool("get_category_breakdown", {
    title: "Category Breakdown",
    description: "Aggregated spending by category for a payee",
    inputSchema: z.object({
      budget_id: z.string(),
      payee_id: z.string(),
      since_date: z.string().optional(),
      until_date: z.string().optional(),
      top: z.number().optional(),
      type: z.enum(["outflow", "inflow", "all"]).optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, payee_id, since_date, until_date, top: topN, type: txType }) => {
    try {
      const top = topN || 50;
      const type = txType || "outflow";
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";
      const data = await ynabFetch(`/budgets/${budget_id}/payees/${payee_id}/transactions${qs}`);
      let txns = data?.data?.transactions ?? [];
      if (until_date) txns = txns.filter(t => t.date <= until_date);
      if (type === "outflow") txns = txns.filter(t => t.amount < 0);
      else if (type === "inflow") txns = txns.filter(t => t.amount > 0);
      const byCat = new Map();
      for (const t of txns) {
        const key = t.category_id || "_no_cat";
        const ex = byCat.get(key);
        if (ex) { ex.total += t.amount; ex.count += 1; }
        else byCat.set(key, { category_id: t.category_id, category_name: t.category_name || "(Sin categoría)", total: t.amount, count: 1 });
      }
      const breakdown = Array.from(byCat.values())
        .sort((a, b) => type === "outflow" ? a.total - b.total : b.total - a.total)
        .slice(0, top)
        .map(c => ({ category_id: c.category_id, category_name: c.category_name, total: muToUnits(c.total), count: c.count }));
      const grand_total = txns.reduce((s, t) => s + t.amount, 0);
      return ok({ payee_id, type, transaction_count: txns.length, grand_total: muToUnits(grand_total), breakdown });
    } catch (e) { return fail(e); }
  });

  // ── Accounts ─────────────────────────────────────────────────────────────

  mcp.registerTool("list_accounts", {
    title: "List Accounts",
    description: "List all accounts with balances",
    inputSchema: z.object({ budget_id: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/accounts`);
      const accounts = data?.data?.accounts?.map(a => ({
        id: a.id, name: a.name, type: a.type, on_budget: a.on_budget, closed: a.closed,
        balance: muToUnits(a.balance), cleared_balance: muToUnits(a.cleared_balance), uncleared_balance: muToUnits(a.uncleared_balance)
      })) ?? [];
      return ok({ accounts });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_account", {
    title: "Get Account",
    description: "Get a single account by ID",
    inputSchema: z.object({ budget_id: z.string(), account_id: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, account_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}`);
      const a = data?.data?.account;
      return ok({
        account: { id: a.id, name: a.name, type: a.type, on_budget: a.on_budget, closed: a.closed,
          balance: muToUnits(a.balance), cleared_balance: muToUnits(a.cleared_balance), uncleared_balance: muToUnits(a.uncleared_balance) }
      });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_account_balance_at_date", {
    title: "Account Balance at Date",
    description: "Historical balance of an account at a specific date",
    inputSchema: z.object({
      budget_id: z.string(),
      account_id: z.string(),
      date: z.string().describe("YYYY-MM-DD")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, account_id, date }) => {
    try {
      const accountData = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}`);
      const account = accountData?.data?.account;
      const currentBalance = account.balance;
      const txnData = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}/transactions?since_date=${date}`);
      const txns = txnData?.data?.transactions ?? [];
      const sumAfter = txns.reduce((s, t) => s + t.amount, 0);
      const balanceAtDate = currentBalance - sumAfter;
      return ok({
        account_id: account.id, account_name: account.name, date,
        current_balance: muToUnits(currentBalance), balance_at_date: muToUnits(balanceAtDate),
        transactions_since: txns.length
      });
    } catch (e) { return fail(e); }
  });

  // ── Categories ───────────────────────────────────────────────────────────

  mcp.registerTool("list_categories", {
    title: "List Categories",
    description: "List category groups and categories, optionally filtered by name",
    inputSchema: z.object({
      budget_id: z.string(),
      name_contains: z.string().optional().describe("Filter by name (case-insensitive)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, name_contains }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/categories`);
      const search = name_contains?.toLowerCase();
      let groups = data?.data?.category_groups?.map(g => {
        let cats = g.categories?.map(c => ({
          id: c.id, name: c.name, hidden: c.hidden,
          budgeted: muToUnits(c.budgeted), activity: muToUnits(c.activity), balance: muToUnits(c.balance)
        })) ?? [];
        if (search) cats = cats.filter(c => c.name?.toLowerCase().includes(search));
        return { id: g.id, name: g.name, hidden: g.hidden, categories: cats };
      }) ?? [];
      if (search) groups = groups.filter(g => g.categories.length > 0);
      return ok({ category_groups: groups });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_category", {
    title: "Get Category",
    description: "Get a single category by ID",
    inputSchema: z.object({ budget_id: z.string(), category_id: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, category_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/categories/${category_id}`);
      const c = data?.data?.category;
      return ok({
        category: { id: c.id, name: c.name, category_group_id: c.category_group_id, category_group_name: c.category_group_name,
          hidden: c.hidden, budgeted: muToUnits(c.budgeted), activity: muToUnits(c.activity), balance: muToUnits(c.balance) }
      });
    } catch (e) { return fail(e); }
  });

  // ── Months ───────────────────────────────────────────────────────────────

  mcp.registerTool("list_months", {
    title: "List Months",
    description: "List all budget months with income, budgeted, activity",
    inputSchema: z.object({ budget_id: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months`);
      const months = data?.data?.months?.map(m => ({
        month: m.month, income: muToUnits(m.income), budgeted: muToUnits(m.budgeted),
        activity: muToUnits(m.activity), to_be_budgeted: muToUnits(m.to_be_budgeted)
      })) ?? [];
      return ok({ months });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_month", {
    title: "Get Month",
    description: "Get a single month detail with categories breakdown",
    inputSchema: z.object({
      budget_id: z.string(),
      month: z.string().describe("YYYY-MM or 'current'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month }) => {
    try {
      const mth = normalizeMonth(month);
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const m = data?.data?.month;
      return ok({
        month: m.month, income: muToUnits(m.income), budgeted: muToUnits(m.budgeted),
        activity: muToUnits(m.activity), to_be_budgeted: muToUnits(m.to_be_budgeted),
        categories: m.categories?.map(c => ({
          id: c.id, name: c.name, category_group_name: c.category_group_name,
          budgeted: muToUnits(c.budgeted), activity: muToUnits(c.activity), balance: muToUnits(c.balance)
        })) ?? []
      });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_month_category_activity", {
    title: "Month Category Activity",
    description: "Categories of a month filtered by name",
    inputSchema: z.object({
      budget_id: z.string(),
      month: z.string().optional(),
      name_contains: z.string().optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month, name_contains }) => {
    try {
      const mth = normalizeMonth(month || "current");
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const m = data?.data?.month;
      const search = name_contains?.toLowerCase();
      let categories = m.categories?.map(c => ({
        id: c.id, name: c.name, category_group_name: c.category_group_name,
        budgeted: muToUnits(c.budgeted), activity: muToUnits(c.activity), balance: muToUnits(c.balance)
      })) ?? [];
      if (search) {
        categories = categories.filter(c =>
          c.name?.toLowerCase().includes(search) || c.category_group_name?.toLowerCase().includes(search));
      }
      return ok({ month: m.month, categories });
    } catch (e) { return fail(e); }
  });

  // ── Payees ───────────────────────────────────────────────────────────────

  mcp.registerTool("list_payees", {
    title: "List Payees",
    description: "List payees, optionally filtered by name",
    inputSchema: z.object({
      budget_id: z.string(),
      name_contains: z.string().optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, name_contains }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/payees`);
      let payees = data?.data?.payees?.map(p => ({ id: p.id, name: p.name, transfer_account_id: p.transfer_account_id })) ?? [];
      if (name_contains) {
        const search = name_contains.toLowerCase();
        payees = payees.filter(p => p.name?.toLowerCase().includes(search));
      }
      return ok({ payees });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_payee", {
    title: "Get Payee",
    description: "Get a single payee by ID",
    inputSchema: z.object({ budget_id: z.string(), payee_id: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, payee_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/payees/${payee_id}`);
      const p = data?.data?.payee;
      return ok({ payee: { id: p.id, name: p.name, transfer_account_id: p.transfer_account_id } });
    } catch (e) { return fail(e); }
  });

  // ── Spending Trend ───────────────────────────────────────────────────────

  mcp.registerTool("get_transactions_sum", {
    title: "Transactions Sum",
    description: "Count and total of transactions matching filters (same filters as spending-trend including exclusions)",
    inputSchema: z.object({
      budget_id: z.string(),
      since_date: z.string().optional(),
      until_date: z.string().optional(),
      account_id: z.string().optional(),
      category_id: z.string().optional(),
      payee_id: z.string().optional(),
      payee_name_contains: z.string().optional(),
      type: z.enum(["outflow", "inflow", "all"]).optional(),
      exclude_transfers: z.boolean().optional(),
      exclude_reconciliations: z.boolean().optional(),
      exclude_category_ids: z.string().optional(),
      exclude_payee_ids: z.string().optional(),
      exclude_payee_names: z.string().optional()
    }),
    annotations: { readOnlyHint: true }
  }, async (args) => {
    try {
      const { budget_id, since_date, until_date, account_id, category_id, payee_id, payee_name_contains } = args;
      const type = args.type || "all";
      const excludeCategoryIds = args.exclude_category_ids ? args.exclude_category_ids.split(",").map(s => s.trim()) : [];
      const excludePayeeIds = args.exclude_payee_ids ? args.exclude_payee_ids.split(",").map(s => s.trim()) : [];
      const excludePayeeNames = args.exclude_payee_names ? args.exclude_payee_names.split(",").map(s => s.trim().toLowerCase()) : [];

      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      let path = `/budgets/${budget_id}/transactions${qs}`;
      if (account_id) path = `/budgets/${budget_id}/accounts/${account_id}/transactions${qs}`;
      else if (category_id) path = `/budgets/${budget_id}/categories/${category_id}/transactions${qs}`;
      else if (payee_id) path = `/budgets/${budget_id}/payees/${payee_id}/transactions${qs}`;

      const data = await ynabFetch(path);
      let txns = data?.data?.transactions ?? [];
      if (until_date) txns = txns.filter(t => t.date <= until_date);
      if (payee_name_contains) { const s = payee_name_contains.toLowerCase(); txns = txns.filter(t => t.payee_name?.toLowerCase().includes(s)); }
      if (type === "outflow") txns = txns.filter(t => t.amount < 0);
      else if (type === "inflow") txns = txns.filter(t => t.amount > 0);
      if (args.exclude_transfers) txns = txns.filter(t => !t.transfer_account_id);
      if (args.exclude_reconciliations) txns = txns.filter(t => !t.payee_name?.toLowerCase().includes("reconciliation") && !t.payee_name?.toLowerCase().includes("starting balance"));
      if (excludeCategoryIds.length) txns = txns.filter(t => !excludeCategoryIds.includes(t.category_id));
      if (excludePayeeIds.length) txns = txns.filter(t => !excludePayeeIds.includes(t.payee_id));
      if (excludePayeeNames.length) txns = txns.filter(t => { const pn = t.payee_name?.toLowerCase() || ""; return !excludePayeeNames.some(n => pn.includes(n)); });

      const total = txns.reduce((s, t) => s + t.amount, 0);
      return ok({ count: txns.length, total: muToUnits(total) });
    } catch (e) { return fail(e); }
  });

  // ── Market P&L ───────────────────────────────────────────────────────────

  mcp.registerTool("list_transactions", {
    title: "List Transactions",
    description: "List transactions with optional filters",
    inputSchema: z.object({
      budget_id: z.string(),
      since_date: z.string().optional(),
      until_date: z.string().optional(),
      type: z.string().optional().describe("YNAB type filter"),
      account_id: z.string().optional(),
      category_id: z.string().optional(),
      payee_id: z.string().optional(),
      payee_name_contains: z.string().optional()
    }),
    annotations: { readOnlyHint: true }
  }, async (args) => {
    try {
      const { budget_id, since_date, until_date, type, account_id, category_id, payee_id, payee_name_contains } = args;
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      if (type) params.set("type", type);
      const qs = params.toString() ? `?${params}` : "";
      let path = `/budgets/${budget_id}/transactions${qs}`;
      if (account_id) path = `/budgets/${budget_id}/accounts/${account_id}/transactions${qs}`;
      else if (category_id) path = `/budgets/${budget_id}/categories/${category_id}/transactions${qs}`;
      else if (payee_id) path = `/budgets/${budget_id}/payees/${payee_id}/transactions${qs}`;
      const data = await ynabFetch(path);
      let txns = data?.data?.transactions ?? [];
      if (until_date) txns = txns.filter(t => t.date <= until_date);
      if (payee_name_contains) { const s = payee_name_contains.toLowerCase(); txns = txns.filter(t => t.payee_name?.toLowerCase().includes(s)); }
      return ok({ transactions: txns.map(mapTransaction) });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_transaction", {
    title: "Get Transaction",
    description: "Get a single transaction by ID",
    inputSchema: z.object({ budget_id: z.string(), transaction_id: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, transaction_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/transactions/${transaction_id}`);
      return ok({ transaction: mapTransaction(data?.data?.transaction) });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("list_scheduled_transactions", {
    title: "List Scheduled Transactions",
    description: "List all scheduled (recurring) transactions",
    inputSchema: z.object({ budget_id: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/scheduled_transactions`);
      return ok({ scheduled_transactions: data?.data?.scheduled_transactions?.map(mapScheduledTransaction) ?? [] });
    } catch (e) { return fail(e); }
  });

  mcp.registerTool("get_scheduled_transaction", {
    title: "Get Scheduled Transaction",
    description: "Get a single scheduled transaction by ID",
    inputSchema: z.object({ budget_id: z.string(), scheduled_transaction_id: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, scheduled_transaction_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/scheduled_transactions/${scheduled_transaction_id}`);
      return ok({ scheduled_transaction: mapScheduledTransaction(data?.data?.scheduled_transaction) });
    } catch (e) { return fail(e); }
  });
}

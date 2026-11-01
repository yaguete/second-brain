import { PublicError } from "../../../shared/utils.js";
import { z } from "zod";
import { ok, fail } from "./helpers.js";
import { ynabFetch, ynabPost, ynabPatch, ynabPut, ynabDelete } from "../client.js";
import { normalizeMonth, muToUnits, getPeriodKey, mapTransaction, mapScheduledTransaction } from "../utils.js";
import { fetchSavingsRate } from "../savings.js";

export function register(mcp) {
  mcp.registerTool("get_spending_trend", {
    title: "Spending Trend",
    description: "Temporal evolution of spending grouped by day/week/month. Filter by category, payee, account, or payee name. Supports exclusions.",
    inputSchema: z.object({
      budget_id: z.string(),
      category_id: z.string().optional(),
      payee_id: z.string().optional(),
      account_id: z.string().optional(),
      payee_name_contains: z.string().optional(),
      since_date: z.string().optional(),
      until_date: z.string().optional(),
      group_by: z.enum(["day", "week", "month"]).optional().describe("Default: month"),
      type: z.enum(["outflow", "inflow", "all"]).optional().describe("Default: outflow"),
      exclude_transfers: z.boolean().optional(),
      exclude_reconciliations: z.boolean().optional(),
      exclude_category_ids: z.string().optional().describe("Comma-separated category IDs to exclude"),
      exclude_payee_ids: z.string().optional().describe("Comma-separated payee IDs to exclude"),
      exclude_payee_names: z.string().optional().describe("Comma-separated payee names to exclude (substring match)")
    }),
    annotations: { readOnlyHint: true }
  }, async (args) => {
    try {
      const { budget_id, category_id, payee_id, account_id, payee_name_contains, since_date, until_date } = args;
      const group_by = args.group_by || "month";
      const type = args.type || "outflow";
      const excludeCategoryIds = args.exclude_category_ids ? args.exclude_category_ids.split(",").map(s => s.trim()) : [];
      const excludePayeeIds = args.exclude_payee_ids ? args.exclude_payee_ids.split(",").map(s => s.trim()) : [];
      const excludePayeeNames = args.exclude_payee_names ? args.exclude_payee_names.split(",").map(s => s.trim().toLowerCase()) : [];

      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      let filter_name = null;
      if (account_id) {
        const ad = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}`);
        filter_name = ad?.data?.account?.name;
      } else if (category_id) {
        const cd = await ynabFetch(`/budgets/${budget_id}/categories/${category_id}`);
        filter_name = cd?.data?.category?.name;
      } else if (payee_id) {
        const pd = await ynabFetch(`/budgets/${budget_id}/payees/${payee_id}`);
        filter_name = pd?.data?.payee?.name;
      }

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

      const byPeriod = new Map();
      for (const t of txns) {
        const key = getPeriodKey(t.date, group_by);
        const ex = byPeriod.get(key);
        if (ex) { ex.total += t.amount; ex.count += 1; } else byPeriod.set(key, { period: key, total: t.amount, count: 1 });
      }
      const periods = Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period)).map(p => ({ period: p.period, total: muToUnits(p.total), count: p.count }));
      const grand_total = txns.reduce((s, t) => s + t.amount, 0);
      const avg = periods.length > 0 ? grand_total / periods.length : 0;

      const result = { group_by, type, transaction_count: txns.length, grand_total: muToUnits(grand_total), avg_per_period: muToUnits(avg), periods };
      if (filter_name) result.filter_name = filter_name;
      if (payee_name_contains) result.payee_name_contains = payee_name_contains;
      return ok(result);
    } catch (e) { return fail(e); }
  });

  // ── Transactions Sum ─────────────────────────────────────────────────────

  mcp.registerTool("get_market_pnl", {
    title: "Market P&L",
    description: "Investment P&L via reconciliation balance adjustments",
    inputSchema: z.object({
      budget_id: z.string(),
      account_id: z.string(),
      since_date: z.string(),
      until_date: z.string()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, account_id, since_date, until_date }) => {
    try {
      const accountData = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}`);
      const account_name = accountData?.data?.account?.name;
      const params = new URLSearchParams(); params.set("since_date", since_date);
      const data = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}/transactions?${params}`);
      let txns = data?.data?.transactions ?? [];
      txns = txns.filter(t => t.date <= until_date && t.payee_name?.toLowerCase().includes("reconciliation balance adjustment") && !t.deleted);
      const market_pnl = txns.reduce((s, t) => s + t.amount, 0);
      return ok({ account_id, account_name, since_date, until_date, reconciliation_count: txns.length, market_pnl: muToUnits(market_pnl) });
    } catch (e) { return fail(e); }
  });

  // ── Transactions ─────────────────────────────────────────────────────────

  mcp.registerTool("get_savings_rate", {
    title: "Savings Rate",
    description: "Behavioural savings rate for a date range: income = 'Inflow: Ready to Assign' (payroll, transfers from other people, interest); expenses = net category activity. Always excludes transfers between own accounts, reconciliation adjustments of tracking accounts, and groups listed in YNAB_SAVINGS_EXCLUDE_GROUPS. Returns the rate with and without groups listed in YNAB_EARMARKED_GROUPS. savings_rate is null when income in the period is below YNAB_SAVINGS_MIN_INCOME.",
    inputSchema: z.object({
      budget_id: z.string(),
      since_date: z.string().describe("YYYY-MM-DD"),
      until_date: z.string().describe("YYYY-MM-DD")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, since_date, until_date }) => {
    try {
      return ok(await fetchSavingsRate({ budget_id, since_date, until_date }));
    } catch (e) { return fail(e); }
  });

  // ── Recurring Expenses ───────────────────────────────────────────────────

  mcp.registerTool("get_recurring_expenses", {
    title: "Recurring Expenses",
    description: "Detect recurring expenses / subscriptions by analyzing transaction patterns",
    inputSchema: z.object({
      budget_id: z.string(),
      months: z.number().optional().describe("Months to analyze (default 3)"),
      min_occurrences: z.number().optional().describe("Minimum month occurrences (default 2)"),
      variance_threshold: z.number().optional().describe("Max variance % (default 20)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, months: numMonths, min_occurrences: minOcc, variance_threshold: varThresh }) => {
    try {
      const mths = numMonths || 3;
      const minOccurrences = minOcc || 2;
      const varianceThreshold = (varThresh || 20) / 100;
      const now = new Date();
      const sinceDate = new Date(now.getFullYear(), now.getMonth() - mths, 1);
      const sinceDateStr = sinceDate.toISOString().split("T")[0];
      const params = new URLSearchParams(); params.set("since_date", sinceDateStr);
      const data = await ynabFetch(`/budgets/${budget_id}/transactions?${params}`);
      let txns = data?.data?.transactions ?? [];
      txns = txns.filter(t => t.amount < 0 && !t.transfer_account_id && !t.deleted && t.payee_name);
      const byPayee = new Map();
      for (const t of txns) {
        const key = t.payee_id || t.payee_name;
        if (!byPayee.has(key)) byPayee.set(key, { payee_id: t.payee_id, payee_name: t.payee_name, transactions: [] });
        byPayee.get(key).transactions.push({ date: t.date, amount: t.amount, month: t.date.substring(0, 7) });
      }
      const recurring = [];
      for (const [, payee] of byPayee) {
        const monthSet = new Set(payee.transactions.map(t => t.month));
        if (monthSet.size < minOccurrences) continue;
        const amounts = payee.transactions.map(t => Math.abs(t.amount));
        const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        const maxDeviation = Math.max(...amounts.map(a => Math.abs(a - avgAmount) / avgAmount));
        if (maxDeviation <= varianceThreshold) {
          recurring.push({
            payee_id: payee.payee_id, payee_name: payee.payee_name,
            occurrences: payee.transactions.length, months_present: monthSet.size,
            avg_amount: muToUnits(avgAmount),
            last_date: payee.transactions.sort((a, b) => b.date.localeCompare(a.date))[0].date
          });
        }
      }
      recurring.sort((a, b) => b.avg_amount - a.avg_amount);
      return ok({ months_analyzed: mths, since_date: sinceDateStr, recurring_count: recurring.length, recurring });
    } catch (e) { return fail(e); }
  });

  // ── Spending Anomalies ───────────────────────────────────────────────────

  mcp.registerTool("get_spending_anomalies", {
    title: "Spending Anomalies",
    description: "Detect unusual spending compared to historical average",
    inputSchema: z.object({
      budget_id: z.string(),
      month: z.string().optional().describe("YYYY-MM or 'current'"),
      threshold: z.number().optional().describe("% above average to flag (default 50)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month, threshold }) => {
    try {
      const anomalyThreshold = (threshold || 50) / 100;
      const mth = normalizeMonth(month || "current");
      const monthData = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const currentCategories = monthData?.data?.month?.categories ?? [];
      const monthsData = await ynabFetch(`/budgets/${budget_id}/months`);
      const allMonths = monthsData?.data?.months ?? [];
      const currentMonthStr = monthData?.data?.month?.month;
      const previousMonths = allMonths.filter(m => m.month < currentMonthStr).slice(0, 6);
      const historicalAvg = new Map();
      for (const prevMonth of previousMonths) {
        const prevData = await ynabFetch(`/budgets/${budget_id}/months/${prevMonth.month}`);
        const cats = prevData?.data?.month?.categories ?? [];
        for (const c of cats) {
          if (c.activity >= 0) continue;
          const existing = historicalAvg.get(c.id) || { total: 0, count: 0, name: c.name, group: c.category_group_name };
          existing.total += Math.abs(c.activity); existing.count += 1;
          historicalAvg.set(c.id, existing);
        }
      }
      const anomalies = [];
      for (const c of currentCategories) {
        if (c.activity >= 0) continue;
        const currentSpending = Math.abs(c.activity);
        const hist = historicalAvg.get(c.id);
        if (!hist || hist.count < 3) continue;
        const avgSpending = hist.total / hist.count;
        if (avgSpending === 0) continue;
        const deviation = (currentSpending - avgSpending) / avgSpending;
        if (deviation > anomalyThreshold) {
          anomalies.push({
            category_id: c.id, category_name: c.name, category_group: hist.group,
            current_spending: muToUnits(currentSpending), avg_spending: muToUnits(avgSpending),
            deviation_percent: Math.round(deviation * 100), excess: muToUnits(currentSpending - avgSpending)
          });
        }
      }
      anomalies.sort((a, b) => b.deviation_percent - a.deviation_percent);
      return ok({ month: currentMonthStr, threshold_percent: threshold || 50, months_compared: previousMonths.length, anomaly_count: anomalies.length, anomalies });
    } catch (e) { return fail(e); }
  });

  // ── Net Worth History ────────────────────────────────────────────────────

  mcp.registerTool("get_net_worth_history", {
    title: "Net Worth History",
    description: "Net worth over time by reconstructing balances from transactions",
    inputSchema: z.object({
      budget_id: z.string(),
      since_date: z.string(),
      until_date: z.string(),
      group_by: z.enum(["day", "week", "month"]).optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, since_date, until_date, group_by: gb }) => {
    try {
      const group_by = gb || "month";
      const accountsData = await ynabFetch(`/budgets/${budget_id}/accounts`);
      const accounts = accountsData?.data?.accounts ?? [];
      const params = new URLSearchParams(); params.set("since_date", since_date);
      const txnData = await ynabFetch(`/budgets/${budget_id}/transactions?${params}`);
      let txns = txnData?.data?.transactions ?? [];
      txns = txns.filter(t => t.date <= until_date && !t.deleted);
      const currentNetWorth = accounts.reduce((s, a) => s + a.balance, 0);
      const txnsByDate = new Map();
      for (const t of txns) { const key = getPeriodKey(t.date, group_by); txnsByDate.set(key, (txnsByDate.get(key) || 0) + t.amount); }
      const periods = Array.from(txnsByDate.keys()).sort();
      const history = [];
      let running = currentNetWorth;
      const futureTxns = txns.filter(t => t.date > until_date);
      running -= futureTxns.reduce((s, t) => s + t.amount, 0);
      for (let i = periods.length - 1; i >= 0; i--) {
        history.unshift({ period: periods[i], net_worth: muToUnits(running) });
        running -= txnsByDate.get(periods[i]);
      }
      return ok({ since_date, until_date, group_by, current_net_worth: muToUnits(currentNetWorth), history });
    } catch (e) { return fail(e); }
  });

  // ── Budget vs Actual ─────────────────────────────────────────────────────

  mcp.registerTool("get_budget_vs_actual", {
    title: "Budget vs Actual",
    description: "Compare budgeted amounts vs actual spending per category",
    inputSchema: z.object({
      budget_id: z.string(),
      month: z.string().optional(),
      show_all: z.boolean().optional().describe("Show categories with zero budget/activity too")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month, show_all }) => {
    try {
      const mth = normalizeMonth(month || "current");
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const monthInfo = data?.data?.month;
      const categories = monthInfo?.categories ?? [];
      const comparison = categories
        .filter(c => show_all ? true : (c.budgeted !== 0 || c.activity !== 0))
        .map(c => {
          const budgeted = c.budgeted;
          const spent = Math.abs(c.activity < 0 ? c.activity : 0);
          const remaining = budgeted - spent;
          const percent_used = budgeted > 0 ? (spent / budgeted) * 100 : (spent > 0 ? 100 : 0);
          let status = "on_track";
          if (percent_used > 100) status = "over_budget";
          else if (percent_used > 80) status = "warning";
          else if (percent_used < 20 && budgeted > 0) status = "under_utilized";
          return {
            category_id: c.id, category_name: c.name, category_group: c.category_group_name,
            budgeted: muToUnits(budgeted), spent: muToUnits(spent), remaining: muToUnits(remaining),
            percent_used: Math.round(percent_used), status
          };
        })
        .sort((a, b) => b.percent_used - a.percent_used);
      return ok({
        month: monthInfo?.month,
        total_budgeted: muToUnits(categories.reduce((s, c) => s + c.budgeted, 0)),
        total_spent: muToUnits(Math.abs(categories.filter(c => c.activity < 0).reduce((s, c) => s + c.activity, 0))),
        over_budget_count: comparison.filter(c => c.status === "over_budget").length,
        categories: comparison
      });
    } catch (e) { return fail(e); }
  });

  // ── Payee Frequency ──────────────────────────────────────────────────────

  mcp.registerTool("get_payee_frequency", {
    title: "Payee Frequency",
    description: "Visit frequency and spending pattern for a payee over time",
    inputSchema: z.object({
      budget_id: z.string(),
      payee_id: z.string().optional(),
      payee_name_contains: z.string().optional(),
      since_date: z.string().optional(),
      until_date: z.string().optional(),
      group_by: z.enum(["day", "week", "month"]).optional()
    }),
    annotations: { readOnlyHint: true }
  }, async (args) => {
    try {
      const { budget_id, payee_id, payee_name_contains, since_date, until_date } = args;
      const group_by = args.group_by || "month";
      if (!payee_id && !payee_name_contains) throw new PublicError(400, "invalid_request", "payee_id or payee_name_contains is required");
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";
      let path = payee_id ? `/budgets/${budget_id}/payees/${payee_id}/transactions${qs}` : `/budgets/${budget_id}/transactions${qs}`;
      const data = await ynabFetch(path);
      let txns = data?.data?.transactions ?? [];
      if (until_date) txns = txns.filter(t => t.date <= until_date);
      if (!payee_id && payee_name_contains) { const s = payee_name_contains.toLowerCase(); txns = txns.filter(t => t.payee_name?.toLowerCase().includes(s)); }
      txns = txns.filter(t => !t.deleted);
      let payee_name = payee_name_contains || "Unknown";
      if (payee_id) {
        const pd = await ynabFetch(`/budgets/${budget_id}/payees/${payee_id}`);
        payee_name = pd?.data?.payee?.name || payee_name;
      } else if (txns.length > 0) payee_name = txns[0].payee_name;
      const byPeriod = new Map();
      for (const t of txns) {
        const key = getPeriodKey(t.date, group_by);
        const ex = byPeriod.get(key) || { count: 0, total: 0 };
        ex.count += 1; ex.total += t.amount;
        byPeriod.set(key, ex);
      }
      const periods = Array.from(byPeriod.entries())
        .map(([period, d]) => ({ period, visit_count: d.count, total_spent: muToUnits(d.total) }))
        .sort((a, b) => a.period.localeCompare(b.period));
      const totalVisits = txns.length;
      const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
      const avgPerVisit = totalVisits > 0 ? totalSpent / totalVisits : 0;
      return ok({
        payee_id: payee_id || null, payee_name, group_by,
        total_visits: totalVisits, total_spent: muToUnits(totalSpent), avg_per_visit: muToUnits(avgPerVisit),
        periods
      });
    } catch (e) { return fail(e); }
  });

  // ── Financial Snapshot ─────────────────────────────────────────────────

  mcp.registerTool("get_financial_snapshot", {
    title: "Financial Snapshot",
    description: "Complete financial dashboard in a single call: month totals, age of money, top 5 spending categories, account balances, net worth, upcoming scheduled transactions, and count of categories with spending but no budget. Use this when the user asks 'how am I doing?' or wants a general overview.",
    inputSchema: z.object({
      budget_id: z.string(),
      month: z.string().optional().describe("YYYY-MM or 'current'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month }) => {
    try {
      const mth = normalizeMonth(month || "current");
      const [monthData, accountsData, scheduledData] = await Promise.all([
        ynabFetch(`/budgets/${budget_id}/months/${mth}`),
        ynabFetch(`/budgets/${budget_id}/accounts`),
        ynabFetch(`/budgets/${budget_id}/scheduled_transactions`)
      ]);
      const m = monthData?.data?.month;
      const accounts = accountsData?.data?.accounts ?? [];
      const scheduled = scheduledData?.data?.scheduled_transactions ?? [];
      const totalBudgeted = m?.categories?.reduce((s, c) => s + (c.budgeted || 0), 0) || 0;
      const totalActivity = m?.categories?.reduce((s, c) => s + (c.activity || 0), 0) || 0;
      const totalBalance = m?.categories?.reduce((s, c) => s + (c.balance || 0), 0) || 0;
      const topSpending = (m?.categories ?? []).filter(c => c.activity < 0).sort((a, b) => a.activity - b.activity).slice(0, 5)
        .map(c => ({ name: c.name, group: c.category_group_name, activity: muToUnits(c.activity) }));
      const activeAccounts = accounts.filter(a => !a.closed).map(a => ({ id: a.id, name: a.name, type: a.type, balance: muToUnits(a.balance) }));
      const netWorth = accounts.reduce((s, a) => s + a.balance, 0);
      const upcoming = scheduled.filter(s => !s.deleted).sort((a, b) => (a.date_next || "").localeCompare(b.date_next || "")).slice(0, 10)
        .map(s => ({ payee_name: s.payee_name, amount: muToUnits(s.amount), date_next: s.date_next, frequency: s.frequency, category_name: s.category_name }));
      const unbudgetedCount = (m?.categories ?? []).filter(c => c.activity < 0 && c.budgeted === 0).length;
      return ok({
        month: m?.month, age_of_money: m?.age_of_money ?? null,
        totals: { budgeted: muToUnits(totalBudgeted), activity: muToUnits(totalActivity), balance: muToUnits(totalBalance) },
        top_spending: topSpending, accounts: activeAccounts, net_worth: muToUnits(netWorth),
        upcoming_scheduled: upcoming, unbudgeted_categories_with_spending: unbudgetedCount
      });
    } catch (e) { return fail(e); }
  });

  // ── Compare Periods ──────────────────────────────────────────────────────

  mcp.registerTool("compare_periods", {
    title: "Compare Periods",
    description: "Compare spending between two months, showing the delta per category. Use this when the user asks 'am I spending more than last month?' or wants to compare any two months side by side.",
    inputSchema: z.object({
      budget_id: z.string(),
      month_a: z.string().describe("First month to compare (YYYY-MM)"),
      month_b: z.string().describe("Second month to compare (YYYY-MM)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month_a, month_b }) => {
    try {
      const mthA = normalizeMonth(month_a);
      const mthB = normalizeMonth(month_b);
      const [dataA, dataB] = await Promise.all([
        ynabFetch(`/budgets/${budget_id}/months/${mthA}`),
        ynabFetch(`/budgets/${budget_id}/months/${mthB}`)
      ]);
      const catsA = dataA?.data?.month?.categories ?? [];
      const catsB = dataB?.data?.month?.categories ?? [];
      const mapB = new Map(catsB.map(c => [c.id, c]));
      const comparison = catsA
        .filter(c => c.activity !== 0 || (mapB.get(c.id)?.activity ?? 0) !== 0)
        .map(c => {
          const b = mapB.get(c.id);
          const actA = c.activity || 0; const actB = b?.activity || 0;
          const delta = actA - actB;
          const pctChange = actB !== 0 ? ((actA - actB) / Math.abs(actB)) * 100 : (actA !== 0 ? 100 : 0);
          return { category_id: c.id, category_name: c.name, category_group: c.category_group_name,
            activity_a: muToUnits(actA), activity_b: muToUnits(actB), delta: muToUnits(delta), pct_change: Math.round(pctChange) };
        })
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const totalA = catsA.reduce((s, c) => s + (c.activity || 0), 0);
      const totalB = catsB.reduce((s, c) => s + (c.activity || 0), 0);
      return ok({
        month_a: dataA?.data?.month?.month, month_b: dataB?.data?.month?.month,
        total_activity_a: muToUnits(totalA), total_activity_b: muToUnits(totalB), total_delta: muToUnits(totalA - totalB),
        categories: comparison
      });
    } catch (e) { return fail(e); }
  });

  // ── Cash Flow Forecast ───────────────────────────────────────────────────

  mcp.registerTool("get_cash_flow_forecast", {
    title: "Cash Flow Forecast",
    description: "Project future balance based on current account balances and upcoming scheduled transactions. Use when the user asks 'how much will I have at end of month?' or 'what bills are coming up?'.",
    inputSchema: z.object({
      budget_id: z.string(),
      days: z.number().optional().describe("Days to forecast (default 30, max 365)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, days: numDays }) => {
    try {
      const daysAhead = Math.max(1, Math.min(365, numDays || 30));
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];
      const endDate = new Date(today.getTime() + daysAhead * 86400000);
      const endDateStr = endDate.toISOString().split("T")[0];
      const [accountsData, scheduledData] = await Promise.all([
        ynabFetch(`/budgets/${budget_id}/accounts`),
        ynabFetch(`/budgets/${budget_id}/scheduled_transactions`)
      ]);
      const accounts = accountsData?.data?.accounts ?? [];
      const currentBalance = accounts.filter(a => !a.closed).reduce((s, a) => s + a.balance, 0);
      const scheduled = (scheduledData?.data?.scheduled_transactions ?? [])
        .filter(s => !s.deleted && s.date_next && s.date_next >= todayStr && s.date_next <= endDateStr);
      const events = scheduled.map(s => ({ date: s.date_next, payee_name: s.payee_name, amount: s.amount, category_name: s.category_name, frequency: s.frequency }))
        .sort((a, b) => a.date.localeCompare(b.date));
      let running = currentBalance;
      const projectedEvents = events.map(e => { running += e.amount; return {
        date: e.date, payee_name: e.payee_name, amount: muToUnits(e.amount), category_name: e.category_name, frequency: e.frequency, projected_balance: muToUnits(running)
      }; });
      const totalInflows = events.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0);
      const totalOutflows = Math.abs(events.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0));
      return ok({
        today: todayStr, forecast_end: endDateStr, days: daysAhead,
        current_balance: muToUnits(currentBalance), projected_balance: muToUnits(running),
        expected_inflows: muToUnits(totalInflows), expected_outflows: muToUnits(totalOutflows),
        scheduled_events: projectedEvents.length, events: projectedEvents
      });
    } catch (e) { return fail(e); }
  });

  // ── Search Transactions ──────────────────────────────────────────────────

  mcp.registerTool("search_transactions", {
    title: "Search Transactions",
    description: "Search transactions by text in memo, payee name, or category name. Use when the user asks 'find transactions mentioning X' or 'search for purchases at Y'.",
    inputSchema: z.object({
      budget_id: z.string(),
      query: z.string().describe("Text to search in memo, payee name, or category name"),
      since_date: z.string().optional(),
      until_date: z.string().optional(),
      account_id: z.string().optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, query, since_date, until_date, account_id }) => {
    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";
      const path = account_id ? `/budgets/${budget_id}/accounts/${account_id}/transactions${qs}` : `/budgets/${budget_id}/transactions${qs}`;
      const data = await ynabFetch(path);
      let txns = data?.data?.transactions ?? [];
      if (until_date) txns = txns.filter(t => t.date <= until_date);
      const search = query.toLowerCase();
      txns = txns.filter(t => (t.memo?.toLowerCase().includes(search)) || (t.payee_name?.toLowerCase().includes(search)) || (t.category_name?.toLowerCase().includes(search)));
      return ok({ query, count: txns.length, transactions: txns.map(mapTransaction) });
    } catch (e) { return fail(e); }
  });

  // ── Update Category Budget ───────────────────────────────────────────────

  mcp.registerTool("get_top_merchants", {
    title: "Top Merchants",
    description: "Top merchants/payees by total spending across all categories in a date range. Use when the user asks 'where do I spend the most?' or 'what are my biggest expenses by store?'.",
    inputSchema: z.object({
      budget_id: z.string(),
      since_date: z.string().optional(),
      until_date: z.string().optional(),
      top: z.number().optional().describe("Max merchants (default 20)"),
      type: z.enum(["outflow", "inflow", "all"]).optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, since_date, until_date, top: topN, type: txType }) => {
    try {
      const top = topN || 20;
      const type = txType || "outflow";
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";
      const data = await ynabFetch(`/budgets/${budget_id}/transactions${qs}`);
      let txns = data?.data?.transactions ?? [];
      if (until_date) txns = txns.filter(t => t.date <= until_date);
      txns = txns.filter(t => !t.transfer_account_id && !t.deleted);
      if (type === "outflow") txns = txns.filter(t => t.amount < 0);
      else if (type === "inflow") txns = txns.filter(t => t.amount > 0);
      const byPayee = new Map();
      for (const t of txns) {
        const key = t.payee_id || t.payee_name || "_unknown";
        const ex = byPayee.get(key);
        if (ex) { ex.total += t.amount; ex.count += 1; }
        else byPayee.set(key, { payee_id: t.payee_id, payee_name: t.payee_name || "(Desconocido)", total: t.amount, count: 1 });
      }
      const merchants = Array.from(byPayee.values())
        .sort((a, b) => type === "outflow" ? a.total - b.total : b.total - a.total)
        .slice(0, top)
        .map(p => ({ payee_id: p.payee_id, payee_name: p.payee_name, total: muToUnits(p.total), count: p.count }));
      return ok({ type, merchant_count: merchants.length, merchants });
    } catch (e) { return fail(e); }
  });

  // ── Unbudgeted Spending ──────────────────────────────────────────────────

  mcp.registerTool("get_unbudgeted_spending", {
    title: "Unbudgeted Spending",
    description: "Find categories where money was spent but no budget was assigned. Helps catch forgotten budgets. Use when user asks 'what am I spending without a budget?' or 'what categories did I forget to budget?'.",
    inputSchema: z.object({
      budget_id: z.string(),
      month: z.string().optional().describe("YYYY-MM or 'current'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month }) => {
    try {
      const mth = normalizeMonth(month || "current");
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const categories = data?.data?.month?.categories ?? [];
      const unbudgeted = categories.filter(c => c.activity < 0 && c.budgeted === 0)
        .map(c => ({ category_id: c.id, category_name: c.name, category_group: c.category_group_name, activity: muToUnits(c.activity) }))
        .sort((a, b) => a.activity - b.activity);
      const totalUnbudgeted = unbudgeted.reduce((s, c) => s + c.activity, 0);
      return ok({ month: data?.data?.month?.month, unbudgeted_count: unbudgeted.length, total_unbudgeted_spending: Math.round(totalUnbudgeted * 100) / 100, categories: unbudgeted });
    } catch (e) { return fail(e); }
  });

  // ── Age of Money ─────────────────────────────────────────────────────────

  mcp.registerTool("get_age_of_money", {
    title: "Age of Money",
    description: "Get the Age of Money metric for a month (days between earning and spending). Higher is better. Use when user asks 'what is my age of money?' or 'how healthy are my finances?'.",
    inputSchema: z.object({
      budget_id: z.string(),
      month: z.string().optional().describe("YYYY-MM or 'current'")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ budget_id, month }) => {
    try {
      const mth = normalizeMonth(month || "current");
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const m = data?.data?.month;
      return ok({ month: m?.month, age_of_money: m?.age_of_money ?? null });
    } catch (e) { return fail(e); }
  });

  return mcp;
}

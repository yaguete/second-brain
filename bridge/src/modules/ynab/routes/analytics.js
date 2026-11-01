import { sendError } from "../../../shared/utils.js";
import { ynabFetch } from "../client.js";
import { normalizeMonth, muToUnits, getPeriodKey, mapTransaction } from "../utils.js";
import { fetchSavingsRate } from "../savings.js";

export function register(app) {
  app.get("/v1/market-pnl", async (req, res) => {
    const { budget_id, account_id, since_date, until_date } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!account_id) return res.status(400).json({ error: "account_id is required" });
    if (!since_date) return res.status(400).json({ error: "since_date is required" });
    if (!until_date) return res.status(400).json({ error: "until_date is required" });

    try {
      // Obtener nombre de la cuenta
      const accountData = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}`);
      const account_name = accountData?.data?.account?.name;

      // Obtener transacciones de la cuenta
      const params = new URLSearchParams();
      params.set("since_date", since_date);
      const data = await ynabFetch(`/budgets/${budget_id}/accounts/${account_id}/transactions?${params}`);
      let transactions = data?.data?.transactions ?? [];

      // Filtrar: solo "Reconciliation Balance Adjustment", dentro del rango, no borradas
      transactions = transactions.filter(t =>
        t.date <= until_date &&
        t.payee_name?.toLowerCase().includes("reconciliation balance adjustment") &&
        !t.deleted
      );

      const market_pnl = transactions.reduce((s, t) => s + t.amount, 0);

      res.json({
        account_id,
        account_name,
        since_date,
        until_date,
        reconciliation_count: transactions.length,
        market_pnl_milliunits: market_pnl,
        market_pnl: muToUnits(market_pnl)
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/savings-rate", async (req, res) => {
    const { budget_id, since_date, until_date } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!since_date) return res.status(400).json({ error: "since_date is required" });
    if (!until_date) return res.status(400).json({ error: "until_date is required" });

    try {
      // Excluye transferencias, reconciliaciones de cuentas de seguimiento y grupos de ahorro (ver savings.js)
      res.json(await fetchSavingsRate({ budget_id, since_date, until_date }));
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Recurring Expenses (detector de suscripciones)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/recurring-expenses", async (req, res) => {
    const {
      budget_id,
      months = "3",
      min_occurrences = "2",
      variance_threshold = "20",
      until_date
    } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const numMonths = parseInt(months, 10);
    const minOccurrences = parseInt(min_occurrences, 10);
    const varianceThreshold = parseFloat(variance_threshold) / 100;

    try {
      // Anchor window to until_date (YYYY-MM or YYYY-MM-DD) or today
      let anchor = new Date();
      if (until_date) {
        const s = String(until_date).trim();
        if (/^\d{4}-\d{2}$/.test(s)) {
          const [y, m] = s.split("-").map(Number);
          anchor = new Date(y, m, 0); // last day of month
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          const [y, m, d] = s.split("-").map(Number);
          anchor = new Date(y, m - 1, d);
        } else {
          return res.status(400).json({ error: "until_date must be YYYY-MM or YYYY-MM-DD" });
        }
      }
      const untilDateStr = anchor.toISOString().split("T")[0];
      const sinceDate = new Date(anchor.getFullYear(), anchor.getMonth() - numMonths + 1, 1);
      const sinceDateStr = sinceDate.toISOString().split("T")[0];

      const params = new URLSearchParams();
      params.set("since_date", sinceDateStr);
      const data = await ynabFetch(`/budgets/${budget_id}/transactions?${params}`);
      let transactions = data?.data?.transactions ?? [];

      // Solo outflows, sin transferencias, acotados al rango
      transactions = transactions.filter(t =>
        t.date >= sinceDateStr &&
        t.date <= untilDateStr &&
        t.amount < 0 &&
        !t.transfer_account_id &&
        !t.deleted &&
        t.payee_name
      );

      // Agrupar por payee
      const byPayee = new Map();
      for (const t of transactions) {
        const key = t.payee_id || t.payee_name;
        if (!byPayee.has(key)) {
          byPayee.set(key, {
            payee_id: t.payee_id,
            payee_name: t.payee_name,
            transactions: []
          });
        }
        byPayee.get(key).transactions.push({
          date: t.date,
          amount: t.amount,
          month: t.date.substring(0, 7)
        });
      }

      const targetMonth = untilDateStr.substring(0, 7);
      const prevMonthDate = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
      const prevMonth = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}`;

      // Filtrar: aparece en múltiples meses con importes similares
      const recurring = [];
      for (const [, payee] of byPayee) {
        const monthSet = new Set(payee.transactions.map(t => t.month));
        if (monthSet.size < minOccurrences) continue;

        const amounts = payee.transactions.map(t => Math.abs(t.amount));
        const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        const maxDeviation = Math.max(...amounts.map(a => Math.abs(a - avgAmount) / avgAmount));

        if (maxDeviation <= varianceThreshold) {
          const byMonth = {};
          for (const t of payee.transactions) {
            byMonth[t.month] = (byMonth[t.month] || 0) + Math.abs(t.amount);
          }
          const targetAmount = byMonth[targetMonth] || null;
          const prevAmount = byMonth[prevMonth] || null;
          const firstMonth = [...monthSet].sort()[0];
          const isNewCandidate = firstMonth === targetMonth;
          const amountChangeCandidate =
            targetAmount != null && prevAmount != null && prevAmount > 0
              ? Math.round(((targetAmount - prevAmount) / prevAmount) * 10000) / 100
              : null;

          recurring.push({
            payee_id: payee.payee_id,
            payee_name: payee.payee_name,
            occurrences: payee.transactions.length,
            months_present: monthSet.size,
            avg_amount_milliunits: Math.round(avgAmount),
            avg_amount: muToUnits(avgAmount),
            last_date: payee.transactions.sort((a, b) => b.date.localeCompare(a.date))[0].date,
            amounts_by_month: Object.fromEntries(
              Object.entries(byMonth).map(([m, v]) => [m, muToUnits(v)])
            ),
            new_subscription_candidate: isNewCandidate,
            amount_change_pct_candidate: amountChangeCandidate
          });
        }
      }

      recurring.sort((a, b) => b.avg_amount_milliunits - a.avg_amount_milliunits);

      res.json({
        months_analyzed: numMonths,
        since_date: sinceDateStr,
        until_date: untilDateStr,
        target_month: targetMonth,
        recurring_count: recurring.length,
        recurring
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Spending Anomalies (gastos inusuales)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/spending-anomalies", async (req, res) => {
    const { budget_id, month = "current", threshold = "50" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const anomalyThreshold = parseFloat(threshold) / 100; // 50% above average

    try {
      // Obtener mes actual y los últimos 6 meses para calcular media
      const mth = normalizeMonth(month);
      const monthData = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const currentCategories = monthData?.data?.month?.categories ?? [];

      // Obtener historial de meses
      const monthsData = await ynabFetch(`/budgets/${budget_id}/months`);
      const allMonths = monthsData?.data?.months ?? [];

      // Tomar los 6 meses anteriores al actual
      const currentMonthStr = monthData?.data?.month?.month;
      const previousMonths = allMonths
        .filter(m => m.month < currentMonthStr)
        .slice(0, 6);

      // Calcular media histórica por categoría
      const historicalAvg = new Map();
      for (const prevMonth of previousMonths) {
        const prevData = await ynabFetch(`/budgets/${budget_id}/months/${prevMonth.month}`);
        const cats = prevData?.data?.month?.categories ?? [];
        for (const c of cats) {
          if (c.activity >= 0) continue; // Solo gastos
          const existing = historicalAvg.get(c.id) || { total: 0, count: 0, name: c.name, group: c.category_group_name };
          existing.total += Math.abs(c.activity);
          existing.count += 1;
          historicalAvg.set(c.id, existing);
        }
      }

      // Comparar mes actual con media
      const anomalies = [];
      for (const c of currentCategories) {
        if (c.activity >= 0) continue;
        const currentSpending = Math.abs(c.activity);
        const hist = historicalAvg.get(c.id);
        if (!hist || hist.count < 3) continue; // Necesitamos al menos 3 meses de historia

        const avgSpending = hist.total / hist.count;
        if (avgSpending === 0) continue;

        const deviation = (currentSpending - avgSpending) / avgSpending;
        if (deviation > anomalyThreshold) {
          anomalies.push({
            category_id: c.id,
            category_name: c.name,
            category_group: hist.group,
            current_spending: muToUnits(currentSpending),
            avg_spending: muToUnits(avgSpending),
            deviation_percent: Math.round(deviation * 100),
            excess: muToUnits(currentSpending - avgSpending)
          });
        }
      }

      // Ordenar por desviación
      anomalies.sort((a, b) => b.deviation_percent - a.deviation_percent);

      res.json({
        month: currentMonthStr,
        threshold_percent: parseFloat(threshold),
        months_compared: previousMonths.length,
        anomaly_count: anomalies.length,
        anomalies
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Net Worth History (patrimonio neto a lo largo del tiempo)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/net-worth-history", async (req, res) => {
    const { budget_id, since_date, until_date, group_by = "month" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!since_date) return res.status(400).json({ error: "since_date is required" });
    if (!until_date) return res.status(400).json({ error: "until_date is required" });
    if (!["day", "week", "month"].includes(group_by)) {
      return res.status(400).json({ error: "group_by must be 'day', 'week', or 'month'" });
    }

    try {
      // Obtener todas las cuentas
      const accountsData = await ynabFetch(`/budgets/${budget_id}/accounts`);
      const accounts = accountsData?.data?.accounts ?? [];

      // Obtener todas las transacciones
      const params = new URLSearchParams();
      params.set("since_date", since_date);
      const txnData = await ynabFetch(`/budgets/${budget_id}/transactions?${params}`);
      let transactions = txnData?.data?.transactions ?? [];
      transactions = transactions.filter(t => t.date <= until_date && !t.deleted);

      // Calcular saldo actual total
      const currentNetWorth = accounts.reduce((s, a) => s + a.balance, 0);

      // Agrupar transacciones por período (en orden inverso para reconstruir saldos)
      const txnsByDate = new Map();
      for (const t of transactions) {
        const key = getPeriodKey(t.date, group_by);
        const existing = txnsByDate.get(key) || 0;
        txnsByDate.set(key, existing + t.amount);
      }

      // Generar puntos de tiempo
      const periods = Array.from(txnsByDate.keys()).sort();

      // Reconstruir net worth hacia atrás
      const history = [];
      let runningNetWorth = currentNetWorth;

      // Primero calcular el cambio después de until_date
      const futureTransactions = transactions.filter(t => t.date > until_date);
      const futureChange = futureTransactions.reduce((s, t) => s + t.amount, 0);
      runningNetWorth -= futureChange;

      // Ahora reconstruir desde el final hacia el inicio
      for (let i = periods.length - 1; i >= 0; i--) {
        const period = periods[i];
        history.unshift({
          period,
          net_worth_milliunits: runningNetWorth,
          net_worth: muToUnits(runningNetWorth)
        });
        runningNetWorth -= txnsByDate.get(period);
      }

      res.json({
        since_date,
        until_date,
        group_by,
        current_net_worth_milliunits: currentNetWorth,
        current_net_worth: muToUnits(currentNetWorth),
        period_count: history.length,
        history
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Budget vs Actual (presupuesto vs gasto real)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/budget-vs-actual", async (req, res) => {
    const { budget_id, month = "current", show_all = "false" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const mth = normalizeMonth(month);
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const monthInfo = data?.data?.month;
      const categories = monthInfo?.categories ?? [];

      const comparison = categories
        .filter(c => {
          // Si show_all=false, solo mostrar categorías con presupuesto o actividad
          if (show_all === "true") return true;
          return c.budgeted !== 0 || c.activity !== 0;
        })
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
            category_id: c.id,
            category_name: c.name,
            category_group: c.category_group_name,
            budgeted: muToUnits(budgeted),
            spent: muToUnits(spent),
            remaining: muToUnits(remaining),
            percent_used: Math.round(percent_used),
            status
          };
        })
        .sort((a, b) => b.percent_used - a.percent_used);

      const over_budget = comparison.filter(c => c.status === "over_budget");
      const on_track = comparison.filter(c => c.status === "on_track" || c.status === "warning");

      res.json({
        month: monthInfo?.month,
        total_budgeted: muToUnits(categories.reduce((s, c) => s + c.budgeted, 0)),
        total_spent: muToUnits(Math.abs(categories.filter(c => c.activity < 0).reduce((s, c) => s + c.activity, 0))),
        over_budget_count: over_budget.length,
        categories: comparison
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Payee Frequency (frecuencia de visita a payees)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/payee-frequency", async (req, res) => {
    const { budget_id, payee_id, payee_name_contains, since_date, until_date, group_by = "month" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!payee_id && !payee_name_contains) {
      return res.status(400).json({ error: "payee_id or payee_name_contains is required" });
    }
    if (!["day", "week", "month"].includes(group_by)) {
      return res.status(400).json({ error: "group_by must be 'day', 'week', or 'month'" });
    }

    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      let path = payee_id
        ? `/budgets/${budget_id}/payees/${payee_id}/transactions${qs}`
        : `/budgets/${budget_id}/transactions${qs}`;

      const data = await ynabFetch(path);
      let transactions = data?.data?.transactions ?? [];

      // Filtrar por until_date
      if (until_date) {
        transactions = transactions.filter(t => t.date <= until_date);
      }

      // Filtrar por payee_name_contains si no hay payee_id
      if (!payee_id && payee_name_contains) {
        const search = payee_name_contains.toLowerCase();
        transactions = transactions.filter(t => t.payee_name?.toLowerCase().includes(search));
      }

      // Excluir borradas
      transactions = transactions.filter(t => !t.deleted);

      // Obtener nombre del payee
      let payee_name = payee_name_contains || "Unknown";
      if (payee_id) {
        const payeeData = await ynabFetch(`/budgets/${budget_id}/payees/${payee_id}`);
        payee_name = payeeData?.data?.payee?.name || payee_name;
      } else if (transactions.length > 0) {
        payee_name = transactions[0].payee_name;
      }

      // Agrupar por período
      const byPeriod = new Map();
      for (const t of transactions) {
        const key = getPeriodKey(t.date, group_by);
        const existing = byPeriod.get(key) || { count: 0, total: 0 };
        existing.count += 1;
        existing.total += t.amount;
        byPeriod.set(key, existing);
      }

      const periods = Array.from(byPeriod.entries())
        .map(([period, data]) => ({
          period,
          visit_count: data.count,
          total_spent_milliunits: data.total,
          total_spent: muToUnits(data.total)
        }))
        .sort((a, b) => a.period.localeCompare(b.period));

      const totalVisits = transactions.length;
      const totalSpent = transactions.reduce((s, t) => s + t.amount, 0);
      const avgPerVisit = totalVisits > 0 ? totalSpent / totalVisits : 0;

      res.json({
        payee_id: payee_id || null,
        payee_name,
        since_date: since_date || null,
        until_date: until_date || null,
        group_by,
        total_visits: totalVisits,
        total_spent_milliunits: totalSpent,
        total_spent: muToUnits(totalSpent),
        avg_per_visit_milliunits: Math.round(avgPerVisit),
        avg_per_visit: muToUnits(avgPerVisit),
        period_count: periods.length,
        periods
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Financial Snapshot (dashboard en una llamada)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/financial-snapshot", async (req, res) => {
    const { budget_id, month = "current" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const mth = normalizeMonth(month);

    try {
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

      const topSpending = (m?.categories ?? [])
        .filter(c => c.activity < 0)
        .sort((a, b) => a.activity - b.activity)
        .slice(0, 5)
        .map(c => ({ name: c.name, group: c.category_group_name, activity: muToUnits(c.activity) }));

      const activeAccounts = accounts
        .filter(a => !a.closed)
        .map(a => ({ id: a.id, name: a.name, type: a.type, balance: muToUnits(a.balance) }));

      const netWorth = accounts.reduce((s, a) => s + a.balance, 0);

      const upcoming = scheduled
        .filter(s => !s.deleted)
        .sort((a, b) => (a.date_next || "").localeCompare(b.date_next || ""))
        .slice(0, 10)
        .map(s => ({
          payee_name: s.payee_name, amount: muToUnits(s.amount),
          date_next: s.date_next, frequency: s.frequency, category_name: s.category_name
        }));

      const unbudgetedCount = (m?.categories ?? []).filter(c => c.activity < 0 && c.budgeted === 0).length;

      res.json({
        month: m?.month,
        age_of_money: m?.age_of_money ?? null,
        totals: { budgeted: muToUnits(totalBudgeted), activity: muToUnits(totalActivity), balance: muToUnits(totalBalance) },
        top_spending: topSpending,
        accounts: activeAccounts,
        net_worth: muToUnits(netWorth),
        upcoming_scheduled: upcoming,
        unbudgeted_categories_with_spending: unbudgetedCount
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Compare Periods (comparar dos meses)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/compare-periods", async (req, res) => {
    const { budget_id, month_a, month_b } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!month_a || !month_b) return res.status(400).json({ error: "month_a and month_b are required (YYYY-MM)" });

    const mthA = normalizeMonth(month_a);
    const mthB = normalizeMonth(month_b);

    try {
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
          const actA = c.activity || 0;
          const actB = b?.activity || 0;
          const delta = actA - actB;
          const pctChange = actB !== 0 ? ((actA - actB) / Math.abs(actB)) * 100 : (actA !== 0 ? 100 : 0);
          return {
            category_id: c.id,
            category_name: c.name,
            category_group: c.category_group_name,
            activity_a: muToUnits(actA),
            activity_b: muToUnits(actB),
            delta: muToUnits(delta),
            pct_change: Math.round(pctChange)
          };
        })
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      const totalA = catsA.reduce((s, c) => s + (c.activity || 0), 0);
      const totalB = catsB.reduce((s, c) => s + (c.activity || 0), 0);

      res.json({
        month_a: dataA?.data?.month?.month,
        month_b: dataB?.data?.month?.month,
        total_activity_a: muToUnits(totalA),
        total_activity_b: muToUnits(totalB),
        total_delta: muToUnits(totalA - totalB),
        categories: comparison
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Cash Flow Forecast
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/cash-flow-forecast", async (req, res) => {
    const { budget_id, days = "30" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const numDays = Math.max(1, Math.min(365, parseInt(days, 10)));
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const endDate = new Date(today.getTime() + numDays * 86400000);
    const endDateStr = endDate.toISOString().split("T")[0];

    try {
      const [accountsData, scheduledData] = await Promise.all([
        ynabFetch(`/budgets/${budget_id}/accounts`),
        ynabFetch(`/budgets/${budget_id}/scheduled_transactions`)
      ]);

      const accounts = accountsData?.data?.accounts ?? [];
      const currentBalance = accounts.filter(a => !a.closed).reduce((s, a) => s + a.balance, 0);

      const scheduled = (scheduledData?.data?.scheduled_transactions ?? [])
        .filter(s => !s.deleted && s.date_next && s.date_next >= todayStr && s.date_next <= endDateStr);

      const events = scheduled
        .map(s => ({ date: s.date_next, payee_name: s.payee_name, amount: s.amount, category_name: s.category_name, frequency: s.frequency }))
        .sort((a, b) => a.date.localeCompare(b.date));

      let runningBalance = currentBalance;
      const projectedEvents = events.map(e => {
        runningBalance += e.amount;
        return {
          date: e.date, payee_name: e.payee_name, amount: muToUnits(e.amount),
          category_name: e.category_name, frequency: e.frequency,
          projected_balance: muToUnits(runningBalance)
        };
      });

      const totalInflows = events.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0);
      const totalOutflows = Math.abs(events.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0));

      res.json({
        today: todayStr,
        forecast_end: endDateStr,
        days: numDays,
        current_balance: muToUnits(currentBalance),
        projected_balance: muToUnits(runningBalance),
        expected_inflows: muToUnits(totalInflows),
        expected_outflows: muToUnits(totalOutflows),
        scheduled_events: projectedEvents.length,
        events: projectedEvents
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Search Transactions (buscar por memo)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/top-merchants", async (req, res) => {
    const { budget_id, since_date, until_date, top = "20", type = "outflow" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!["inflow", "outflow", "all"].includes(type)) {
      return res.status(400).json({ error: "type must be 'inflow', 'outflow', or 'all'" });
    }

    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      const data = await ynabFetch(`/budgets/${budget_id}/transactions${qs}`);
      let transactions = data?.data?.transactions ?? [];

      if (until_date) transactions = transactions.filter(t => t.date <= until_date);
      transactions = transactions.filter(t => !t.transfer_account_id && !t.deleted);

      if (type === "outflow") transactions = transactions.filter(t => t.amount < 0);
      else if (type === "inflow") transactions = transactions.filter(t => t.amount > 0);

      const byPayee = new Map();
      for (const t of transactions) {
        const key = t.payee_id || t.payee_name || "_unknown";
        const ex = byPayee.get(key);
        if (ex) { ex.total += t.amount; ex.count += 1; }
        else byPayee.set(key, { payee_id: t.payee_id, payee_name: t.payee_name || "(Desconocido)", total: t.amount, count: 1 });
      }

      const merchants = Array.from(byPayee.values())
        .sort((a, b) => type === "outflow" ? a.total - b.total : b.total - a.total)
        .slice(0, Number(top))
        .map(p => ({ payee_id: p.payee_id, payee_name: p.payee_name, total: muToUnits(p.total), count: p.count }));

      res.json({
        type, since_date: since_date || null, until_date: until_date || null,
        merchant_count: merchants.length, merchants
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Unbudgeted Spending
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/unbudgeted-spending", async (req, res) => {
    const { budget_id, month = "current" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const mth = normalizeMonth(month);

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const categories = data?.data?.month?.categories ?? [];

      const unbudgeted = categories
        .filter(c => c.activity < 0 && c.budgeted === 0)
        .map(c => ({
          category_id: c.id, category_name: c.name, category_group: c.category_group_name,
          activity: muToUnits(c.activity)
        }))
        .sort((a, b) => a.activity - b.activity);

      const totalUnbudgeted = unbudgeted.reduce((s, c) => s + c.activity, 0);

      res.json({
        month: data?.data?.month?.month,
        unbudgeted_count: unbudgeted.length,
        total_unbudgeted_spending: Math.round(totalUnbudgeted * 100) / 100,
        categories: unbudgeted
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Age of Money
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/age-of-money", async (req, res) => {
    const { budget_id, month = "current" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const mth = normalizeMonth(month);

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const m = data?.data?.month;

      res.json({
        month: m?.month,
        age_of_money: m?.age_of_money ?? null
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // MCP Server (Model Context Protocol)
  // ─────────────────────────────────────────────────────────────────────────────
}

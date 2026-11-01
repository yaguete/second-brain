import { sendError } from "../../../shared/utils.js";
import { ynabFetch } from "../client.js";
import { normalizeMonth, muToUnits } from "../utils.js";

export function register(app) {
  app.get("/v1/budgets", async (_req, res) => {
    try {
      const data = await ynabFetch("/budgets");
      const budgets = data?.data?.budgets?.map(b => ({ id: b.id, name: b.name })) ?? [];
      res.json({ budgets });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/month-summary", async (req, res) => {
    const { budget_id, month = "current" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const mth = normalizeMonth(month);

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const monthData = data?.data?.month;

      const totalBudgeted = monthData?.categories?.reduce((s, c) => s + (c.budgeted || 0), 0) || 0;
      const totalActivity = monthData?.categories?.reduce((s, c) => s + (c.activity || 0), 0) || 0;
      const totalBalance  = monthData?.categories?.reduce((s, c) => s + (c.balance  || 0), 0) || 0;

      res.json({
        month: monthData?.month,
        totals_milliunits: { budgeted: totalBudgeted, activity: totalActivity, balance: totalBalance },
        totals: {
          budgeted: muToUnits(totalBudgeted),
          activity: muToUnits(totalActivity),
          balance: muToUnits(totalBalance)
        }
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/spending-by-category", async (req, res) => {
    const { budget_id, month = "current", top = "50" } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const mth = normalizeMonth(month);

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const cats = data?.data?.month?.categories ?? [];

      const spending_milliunits = cats
        .map(c => ({
          id: c.id,
          name: c.name,
          group: c.category_group_name,
          activity: c.activity || 0
        }))
        .filter(c => c.activity < 0)
        .sort((a, b) => a.activity - b.activity)
        .slice(0, Number(top));

      const spending = spending_milliunits.map(x => ({
        id: x.id,
        name: x.name,
        group: x.group,
        activity: muToUnits(x.activity)
      }));

      res.json({
        month: data?.data?.month?.month,
        spending_milliunits,
        spending
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Payee Breakdown (agregado server-side)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/payee-breakdown", async (req, res) => {
    const { budget_id, category_id, payee_id, since_date, until_date, type = "outflow" } = req.query;
    const top = Math.max(1, Math.min(500, parseInt(req.query.top ?? "50", 10)));

    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!category_id) return res.status(400).json({ error: "category_id is required" });
    if (!["inflow", "outflow", "all"].includes(type)) {
      return res.status(400).json({ error: "type must be 'inflow', 'outflow', or 'all'" });
    }

    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      const data = await ynabFetch(`/budgets/${budget_id}/categories/${category_id}/transactions${qs}`);
      let transactions = data?.data?.transactions ?? [];

      // Filtrar por until_date si se proporciona
      if (until_date) {
        transactions = transactions.filter(t => t.date <= until_date);
      }

      // Filtrar por payee_id si se proporciona (opción A)
      if (payee_id) {
        transactions = transactions.filter(t => t.payee_id === payee_id);
      }

      // Filtrar por tipo de transacción
      if (type === "outflow") {
        transactions = transactions.filter(t => t.amount < 0);
      } else if (type === "inflow") {
        transactions = transactions.filter(t => t.amount > 0);
      }

      // Agregar por payee
      const byPayee = new Map();
      for (const t of transactions) {
        const key = t.payee_id || "_no_payee";
        const existing = byPayee.get(key);
        if (existing) {
          existing.total += t.amount;
          existing.count += 1;
        } else {
          byPayee.set(key, {
            payee_id: t.payee_id,
            payee_name: t.payee_name || "(Sin payee)",
            total: t.amount,
            count: 1
          });
        }
      }

      // Convertir a array, ordenar y limitar
      // outflow: más negativo primero | inflow/all: más positivo primero
      const breakdown_milliunits = Array.from(byPayee.values())
        .sort((a, b) => type === "outflow" ? a.total - b.total : b.total - a.total)
        .slice(0, top);

      const breakdown = breakdown_milliunits.map(p => ({
        payee_id: p.payee_id,
        payee_name: p.payee_name,
        total: muToUnits(p.total),
        count: p.count
      }));

      const grand_total = transactions.reduce((s, t) => s + t.amount, 0);

      res.json({
        category_id,
        type,
        since_date: since_date || null,
        until_date: until_date || null,
        transaction_count: transactions.length,
        payee_count: byPayee.size,
        grand_total_milliunits: grand_total,
        grand_total: muToUnits(grand_total),
        breakdown_milliunits,
        breakdown
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Category Breakdown (inverso de payee-breakdown: dado un payee, agrupa por categoría)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/v1/category-breakdown", async (req, res) => {
    const { budget_id, payee_id, since_date, until_date, type = "outflow" } = req.query;
    const top = Math.max(1, Math.min(500, parseInt(req.query.top ?? "50", 10)));

    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });
    if (!payee_id) return res.status(400).json({ error: "payee_id is required" });
    if (!["inflow", "outflow", "all"].includes(type)) {
      return res.status(400).json({ error: "type must be 'inflow', 'outflow', or 'all'" });
    }

    try {
      const params = new URLSearchParams();
      if (since_date) params.set("since_date", since_date);
      const qs = params.toString() ? `?${params}` : "";

      const data = await ynabFetch(`/budgets/${budget_id}/payees/${payee_id}/transactions${qs}`);
      let transactions = data?.data?.transactions ?? [];

      // Filtrar por until_date si se proporciona
      if (until_date) {
        transactions = transactions.filter(t => t.date <= until_date);
      }

      // Filtrar por tipo de transacción
      if (type === "outflow") {
        transactions = transactions.filter(t => t.amount < 0);
      } else if (type === "inflow") {
        transactions = transactions.filter(t => t.amount > 0);
      }

      // Agregar por categoría
      const byCategory = new Map();
      for (const t of transactions) {
        const key = t.category_id || "_no_category";
        const existing = byCategory.get(key);
        if (existing) {
          existing.total += t.amount;
          existing.count += 1;
        } else {
          byCategory.set(key, {
            category_id: t.category_id,
            category_name: t.category_name || "(Sin categoría)",
            total: t.amount,
            count: 1
          });
        }
      }

      // Convertir a array, ordenar y limitar
      const breakdown_milliunits = Array.from(byCategory.values())
        .sort((a, b) => type === "outflow" ? a.total - b.total : b.total - a.total)
        .slice(0, top);

      const breakdown = breakdown_milliunits.map(c => ({
        category_id: c.category_id,
        category_name: c.category_name,
        total: muToUnits(c.total),
        count: c.count
      }));

      const grand_total = transactions.reduce((s, t) => s + t.amount, 0);

      res.json({
        payee_id,
        type,
        since_date: since_date || null,
        until_date: until_date || null,
        transaction_count: transactions.length,
        category_count: byCategory.size,
        grand_total_milliunits: grand_total,
        grand_total: muToUnits(grand_total),
        breakdown_milliunits,
        breakdown
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Accounts
  // ─────────────────────────────────────────────────────────────────────────────
}

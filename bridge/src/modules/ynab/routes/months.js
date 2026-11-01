import { sendError } from "../../../shared/utils.js";
import { ynabFetch } from "../client.js";
import { normalizeMonth, muToUnits } from "../utils.js";

export function register(app) {
  app.get("/v1/months", async (req, res) => {
    const { budget_id } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months`);
      const months = data?.data?.months?.map(m => ({
        month: m.month,
        income: m.income,
        income_units: muToUnits(m.income),
        budgeted: m.budgeted,
        budgeted_units: muToUnits(m.budgeted),
        activity: m.activity,
        activity_units: muToUnits(m.activity),
        to_be_budgeted: m.to_be_budgeted,
        to_be_budgeted_units: muToUnits(m.to_be_budgeted)
      })) ?? [];
      res.json({ months });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/months/:month", async (req, res) => {
    const { budget_id } = req.query;
    const month = normalizeMonth(req.params.month);
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months/${month}`);
      const m = data?.data?.month;
      res.json({
        month: {
          month: m.month,
          income: m.income,
          income_units: muToUnits(m.income),
          budgeted: m.budgeted,
          budgeted_units: muToUnits(m.budgeted),
          activity: m.activity,
          activity_units: muToUnits(m.activity),
          to_be_budgeted: m.to_be_budgeted,
          to_be_budgeted_units: muToUnits(m.to_be_budgeted),
          categories: m.categories?.map(c => ({
            id: c.id,
            name: c.name,
            category_group_name: c.category_group_name,
            budgeted: c.budgeted,
            budgeted_units: muToUnits(c.budgeted),
            activity: c.activity,
            activity_units: muToUnits(c.activity),
            balance: c.balance,
            balance_units: muToUnits(c.balance)
          })) ?? []
        }
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/month-category-activity", async (req, res) => {
    const { budget_id, month = "current", name_contains } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const mth = normalizeMonth(month);

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months/${mth}`);
      const m = data?.data?.month;
      const search = name_contains?.toLowerCase();

      let categories = m.categories?.map(c => ({
        id: c.id,
        name: c.name,
        category_group_name: c.category_group_name,
        budgeted: c.budgeted,
        budgeted_units: muToUnits(c.budgeted),
        activity: c.activity,
        activity_units: muToUnits(c.activity),
        balance: c.balance,
        balance_units: muToUnits(c.balance)
      })) ?? [];

      // Filtrar por nombre de categoría
      if (search) {
        categories = categories.filter(c =>
          c.name?.toLowerCase().includes(search) ||
          c.category_group_name?.toLowerCase().includes(search)
        );
      }

      res.json({
        month: m.month,
        categories
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Payees
  // ─────────────────────────────────────────────────────────────────────────────
}

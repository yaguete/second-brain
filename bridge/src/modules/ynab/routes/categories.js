import { sendError } from "../../../shared/utils.js";
import { ynabFetch, ynabPatch } from "../client.js";
import { muToUnits } from "../utils.js";

export function register(app) {
  app.get("/v1/categories", async (req, res) => {
    const { budget_id, name_contains } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/categories`);
      const search = name_contains?.toLowerCase();

      let category_groups = data?.data?.category_groups?.map(g => {
        let categories = g.categories?.map(c => ({
          id: c.id,
          name: c.name,
          hidden: c.hidden,
          budgeted: c.budgeted,
          budgeted_units: muToUnits(c.budgeted),
          activity: c.activity,
          activity_units: muToUnits(c.activity),
          balance: c.balance,
          balance_units: muToUnits(c.balance)
        })) ?? [];

        // Filtrar categorías por nombre
        if (search) {
          categories = categories.filter(c => c.name?.toLowerCase().includes(search));
        }

        return {
          id: g.id,
          name: g.name,
          hidden: g.hidden,
          categories
        };
      }) ?? [];

      // Eliminar grupos vacíos si hay filtro
      if (search) {
        category_groups = category_groups.filter(g => g.categories.length > 0);
      }

      res.json({ category_groups });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/categories/:category_id", async (req, res) => {
    const { budget_id } = req.query;
    const { category_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/categories/${category_id}`);
      const c = data?.data?.category;
      res.json({
        category: {
          id: c.id,
          name: c.name,
          category_group_id: c.category_group_id,
          category_group_name: c.category_group_name,
          hidden: c.hidden,
          budgeted: c.budgeted,
          budgeted_units: muToUnits(c.budgeted),
          activity: c.activity,
          activity_units: muToUnits(c.activity),
          balance: c.balance,
          balance_units: muToUnits(c.balance)
        }
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Months
  // ─────────────────────────────────────────────────────────────────────────────

  app.patch("/v1/categories/:category_id/budget", async (req, res) => {
    const { budget_id, month = "current" } = req.query;
    const { category_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    const mth = normalizeMonth(month);
    const { budgeted } = req.body;
    if (budgeted === undefined) return res.status(400).json({ error: "budgeted is required (in milliunits)" });

    try {
      const data = await ynabPatch(`/budgets/${budget_id}/months/${mth}/categories/${category_id}`, {
        category: { budgeted: Number(budgeted) }
      });
      const c = data?.data?.category;
      res.json({
        category: {
          id: c.id, name: c.name, month: mth,
          budgeted: c.budgeted, budgeted_units: muToUnits(c.budgeted),
          activity: c.activity, activity_units: muToUnits(c.activity),
          balance: c.balance, balance_units: muToUnits(c.balance)
        }
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Top Merchants
  // ─────────────────────────────────────────────────────────────────────────────
}

import { sendError } from "../../../shared/utils.js";
import { ynabFetch } from "../client.js";

export function register(app) {
  app.get("/v1/payees", async (req, res) => {
    const { budget_id, name_contains } = req.query;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/payees`);
      let payees = data?.data?.payees?.map(p => ({
        id: p.id,
        name: p.name,
        transfer_account_id: p.transfer_account_id
      })) ?? [];

      // Filtrar por nombre (case-insensitive)
      if (name_contains) {
        const search = name_contains.toLowerCase();
        payees = payees.filter(p => p.name?.toLowerCase().includes(search));
      }

      res.json({ payees });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/payees/:payee_id", async (req, res) => {
    const { budget_id } = req.query;
    const { payee_id } = req.params;
    if (!budget_id) return res.status(400).json({ error: "budget_id is required" });

    try {
      const data = await ynabFetch(`/budgets/${budget_id}/payees/${payee_id}`);
      const p = data?.data?.payee;
      res.json({
        payee: {
          id: p.id,
          name: p.name,
          transfer_account_id: p.transfer_account_id
        }
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Spending Trend (agregado por período)
  // ─────────────────────────────────────────────────────────────────────────────

  function getWeekNumber(dateStr) {
    const date = new Date(dateStr);
    const startOfYear = new Date(date.getFullYear(), 0, 1);
    const days = Math.floor((date - startOfYear) / (24 * 60 * 60 * 1000));
    return Math.ceil((days + startOfYear.getDay() + 1) / 7);
  }

  function getPeriodKey(dateStr, groupBy) {
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    switch (groupBy) {
      case "day":
        return `${year}-${month}-${day}`;
      case "week":
        const week = String(getWeekNumber(dateStr)).padStart(2, "0");
        return `${year}-W${week}`;
      case "month":
      default:
        return `${year}-${month}`;
    }
  }
}

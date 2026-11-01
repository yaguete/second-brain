import { register as registerBudgets } from "./budgets.js";
import { register as registerAccounts } from "./accounts.js";
import { register as registerCategories } from "./categories.js";
import { register as registerMonths } from "./months.js";
import { register as registerPayees } from "./payees.js";
import { register as registerTransactions } from "./transactions.js";
import { register as registerScheduledTransactions } from "./scheduled-transactions.js";
import { register as registerAnalytics } from "./analytics.js";

export function registerYnabRoutes(app) {
  registerBudgets(app);
  registerAccounts(app);
  registerCategories(app);
  registerMonths(app);
  registerPayees(app);
  registerTransactions(app);
  registerScheduledTransactions(app);
  registerAnalytics(app);
}

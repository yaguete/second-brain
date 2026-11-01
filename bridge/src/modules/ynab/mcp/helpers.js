export { mcpFail as fail } from "../../../shared/utils.js";

export const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

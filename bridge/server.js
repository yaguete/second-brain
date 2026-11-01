import { PORT, bootConfig } from "./src/config.js";

const boot = bootConfig();
if (!boot.ok) {
  console.error(boot.error);
  process.exit(1);
}

const { createApp, initSchemas } = await import("./app.js");
const app = createApp();
initSchemas().then(() => {
  app.listen(PORT, () => console.log(`second-brain listening on port ${PORT}`));
});

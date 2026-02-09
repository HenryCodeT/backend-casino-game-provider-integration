import "dotenv/config";
import app from "./app";
import { prisma } from "./db";
import { logger } from "./utils/logger";

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info(`${signal} received – shutting down`);
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

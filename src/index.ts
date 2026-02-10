import "dotenv/config";
import app from "./app";
import { prisma } from "./db";

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.info(`Casino API is running on port ${PORT}!`);
});

const shutdown = async (signal: string) => {
  console.info(`${signal} received – shutting down`);
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

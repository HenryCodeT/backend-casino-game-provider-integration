import express from "express";
import casinoRoutes from "./casino/casino.routes";
import providerRoutes from "./provider/provider.routes";

const app = express();

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Route namespaces
app.use("/casino", casinoRoutes);
app.use("/provider", providerRoutes);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default app;

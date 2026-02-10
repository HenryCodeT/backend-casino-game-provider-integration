import express from "express";
import casinoRoutes from "./casino/casino.routes";
import providerRoutes from "./provider/provider.routes";

const app: express.Express = express();

app.use(express.json());

app.use("/casino", casinoRoutes);
app.use("/provider", providerRoutes);


export default app;

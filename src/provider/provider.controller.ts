import { Request, Response } from "express";
import * as providerService from "./provider.service";

export async function launch(req: Request, res: Response) {
  try {
    const result = await providerService.launchSession(req.body);
    return res.json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, details: err.details });
    }
    console.error("provider launch error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function simulate(req: Request, res: Response) {
  try {
    const result = await providerService.simulateRound(req.body);
    return res.json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, details: err.details });
    }
    console.error("provider simulate error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

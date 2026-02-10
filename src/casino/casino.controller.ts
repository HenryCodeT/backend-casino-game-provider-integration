import { Request, Response } from "express";
import * as casinoService from "./casino.service";

export async function launchGame(req: Request, res: Response) {
  try {
    const result = await casinoService.launchGame(req.body);
    return res.json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, details: err.details });
    }
    if (err instanceof Error && err.message === "INSUFFICIENT_FUNDS") {
      return res.status(400).json({ error: "Insufficient funds" });
    }
    console.error("casino launchGame error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function getBalance(req: Request, res: Response) {
  try {
    const result = await casinoService.getBalance(req.body);
    return res.json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, details: err.details });
    }
    console.error("casino getBalance error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function debit(req: Request, res: Response) {
  try {
    const result = await casinoService.debit(req.body);
    return res.json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, details: err.details });
    }
    if (err instanceof Error && err.message === "INSUFFICIENT_FUNDS") {
      return res.status(400).json({ error: "Insufficient funds" });
    }
    console.error("casino debit error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function credit(req: Request, res: Response) {
  try {
    const result = await casinoService.credit(req.body);
    return res.json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, details: err.details });
    }
    console.error("casino credit error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function rollback(req: Request, res: Response) {
  try {
    const result = await casinoService.rollback(req.body);
    return res.json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, details: err.details });
    }
    console.error("casino rollback error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function simulateRound(req: Request, res: Response) {
  try {
    const result = await casinoService.simulateRound(req.body);
    return res.json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error, details: err.details });
    }
    console.error("casino simulateRound error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

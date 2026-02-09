import { Router } from "express";
import { verifyCasinoSignature } from "./casino.hmac";
import {
  launchGame,
  getBalance,
  debit,
  credit,
  rollback,
} from "./casino.handlers";

const router: Router = Router();

// Client-initiated (no HMAC needed — would normally use user auth)
router.post("/launchGame", launchGame);

// Provider callbacks (HMAC-protected)
router.post("/getBalance", verifyCasinoSignature, getBalance);
router.post("/debit", verifyCasinoSignature, debit);
router.post("/credit", verifyCasinoSignature, credit);
router.post("/rollback", verifyCasinoSignature, rollback);

export default router;

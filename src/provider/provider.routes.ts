import { Router } from "express";
import { verifyProviderSignature } from "./provider.hmac";
import { launch, simulate } from "./provider.handlers";

const router: Router = Router();

// Casino-initiated (HMAC-protected)
router.post("/launch", verifyProviderSignature, launch);
router.post("/simulate", verifyProviderSignature, simulate);

export default router;

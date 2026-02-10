import { Router } from "express";
import { verifyProviderSignature } from "./provider.hmac";
import { launch, simulate } from "./provider.controller";

const router: Router = Router();

router.post("/launch", verifyProviderSignature, launch);
router.post("/simulate", verifyProviderSignature, simulate);

export default router;

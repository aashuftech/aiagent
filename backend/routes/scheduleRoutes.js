import { Router } from "express";
import { postSchedule } from "../controllers/scheduleController.js";

const router = Router();

router.post("/", postSchedule);

export default router;

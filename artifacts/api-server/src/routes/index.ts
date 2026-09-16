import { Router, type IRouter } from "express";
import healthRouter from "./health";
import recruitmentRouter from "./recruitment";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(recruitmentRouter);
router.use(storageRouter);

export default router;

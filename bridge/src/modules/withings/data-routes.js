import { sendError } from "../../shared/utils.js";
import { requireWithingsEnv } from "./middleware.js";
import {
  withingsGetBodyMeasurements,
  withingsGetActivity,
  withingsGetWorkouts,
  withingsGetSleepSummary
} from "./api.js";

function parseYmdRange(req, res) {
  const { startdateymd, enddateymd } = req.query;
  if (startdateymd && !/^\d{4}-\d{2}-\d{2}$/.test(String(startdateymd))) {
    res.status(400).json({ error: "startdateymd must be YYYY-MM-DD" });
    return null;
  }
  if (enddateymd && !/^\d{4}-\d{2}-\d{2}$/.test(String(enddateymd))) {
    res.status(400).json({ error: "enddateymd must be YYYY-MM-DD" });
    return null;
  }
  return {
    startdateymd: startdateymd ? String(startdateymd) : undefined,
    enddateymd: enddateymd ? String(enddateymd) : undefined,
    lastupdate: req.query.lastupdate,
    data_fields: req.query.data_fields ? String(req.query.data_fields) : undefined
  };
}

export function registerWithingsDataRoutes(app) {
  app.get("/v1/withings/body-measurements", requireWithingsEnv, async (req, res) => {
    try {
      const { startdate, enddate, meastypes, category, lastupdate } = req.query;
      const data = await withingsGetBodyMeasurements({
        startdate,
        enddate,
        meastypes: meastypes ? String(meastypes) : undefined,
        category: category != null ? Number(category) : undefined,
        lastupdate
      });
      res.json(data);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/withings/activity", requireWithingsEnv, async (req, res) => {
    try {
      const range = parseYmdRange(req, res);
      if (!range) return;
      const data = await withingsGetActivity(range);
      res.json(data);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/withings/workouts", requireWithingsEnv, async (req, res) => {
    try {
      const range = parseYmdRange(req, res);
      if (!range) return;
      const data = await withingsGetWorkouts(range);
      res.json(data);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/withings/sleep-summary", requireWithingsEnv, async (req, res) => {
    try {
      const range = parseYmdRange(req, res);
      if (!range) return;
      const data = await withingsGetSleepSummary(range);
      res.json(data);
    } catch (e) {
      sendError(res, e);
    }
  });
}

import pg from "pg";
import { DATABASE_SSL } from "../config.js";

export const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : false
    })
  : null;

export const EMBEDDING_DIM = 1536;

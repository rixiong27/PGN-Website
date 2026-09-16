import { boolean, integer, jsonb, pgTable, real, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("pgn_users", {
  id: serial("id").primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("pending"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pnmsTable = pgTable("pgn_pnms", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  pronouns: text("pronouns"),
  email: text("email"),
  year: text("year"),
  major: text("major"),
  minor: text("minor"),
  gpa: real("gpa"),
  photoPath: text("photo_path"),
  status: text("status").notNull().default("new"),
  archived: boolean("archived").notNull().default(false),
  semester: text("semester"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notesTable = pgTable("pgn_notes", {
  id: serial("id").primaryKey(),
  pnmId: integer("pnm_id").notNull(),
  authorId: integer("author_id").notNull(),
  authorName: text("author_name").notNull(),
  content: text("content").notNull(),
  pinned: boolean("pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const votingRoundsTable = pgTable("pgn_voting_rounds", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("open"),
  // Existing closed rounds with a null mode are the historical 1–5 rounds.
  // New rounds always set this to binary; open legacy rounds are reset by the
  // versioned recruitment migration before the API starts.
  votingMode: text("voting_mode"),
  electorateCount: integer("electorate_count"),
  resultsSnapshot: jsonb("results_snapshot"),
  pnmIds: integer("pnm_ids").array().notNull(),
  deadline: timestamp("deadline", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const votesTable = pgTable("pgn_votes", {
  id: serial("id").primaryKey(),
  roundId: integer("round_id").notNull(),
  pnmId: integer("pnm_id").notNull(),
  voterId: integer("voter_id").notNull(),
  score: integer("score").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueVote: uniqueIndex("pgn_votes_round_pnm_voter_idx").on(table.roundId, table.pnmId, table.voterId),
}));

export const activityTable = pgTable("pgn_activity", {
  id: serial("id").primaryKey(),
  actorName: text("actor_name").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invitesTable = pgTable("pgn_invites", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  label: text("label"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPnmSchema = createInsertSchema(pnmsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPnm = z.infer<typeof insertPnmSchema>;
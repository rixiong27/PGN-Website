import { getAuth } from "@clerk/express";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import {
  ApproveMemberParams,
  CastVoteBody,
  CastVoteParams,
  CloseVotingRoundParams,
  CreateUserBody,
  CreateNoteBody,
  CreateNoteParams,
  CreatePnmBody,
  CreateVotingRoundBody,
  DeletePnmParams,
  GetPnmParams,
  GetVotingRoundParams,
  ImportPnmsBody,
  ListActivityQueryParams,
  ListNotesParams,
  ListPnmsQueryParams,
  RejectMemberParams,
  ToggleNotePinBody,
  ToggleNotePinParams,
  UpdatePnmBody,
  UpdatePnmParams,
  UpdateUserRoleBody,
  UpdateUserRoleParams,
  ValidateInviteBody,
} from "@workspace/api-zod";

const router: IRouter = Router();
type Role = "super_admin" | "admin" | "member" | "pending";
type MemberRow = { id: number; clerk_id: string; name: string; email: string; role: Role; status: string; created_at: Date };
type AuthedRequest = Request & { member?: MemberRow };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function memberView(member: MemberRow) {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    status: member.status,
    createdAt: new Date(member.created_at).toISOString(),
  };
}

function pnmView(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    firstName: asString(row.first_name),
    lastName: asString(row.last_name),
    pronouns: (row.pronouns as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    year: (row.year as string | null) ?? null,
    major: (row.major as string | null) ?? null,
    minor: (row.minor as string | null) ?? null,
    gpa: row.gpa == null ? null : Number(row.gpa),
    photoPath: (row.photo_path as string | null) ?? null,
    status: row.status,
    archived: Boolean(row.archived),
    semester: (row.semester as string | null) ?? null,
    averageVote: row.average_vote == null ? null : Number(Number(row.average_vote).toFixed(2)),
    voteCount: Number(row.vote_count ?? 0),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

async function ensureMember(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const auth = getAuth(req);
  const clerkId = auth.userId;
  if (!clerkId) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  const claims = (auth.sessionClaims ?? {}) as Record<string, unknown>;
  const email = asString(claims.email ?? claims.email_address).toLowerCase() || `${clerkId}@vt.edu`;
  if (!email.endsWith("@vt.edu")) {
    res.status(403).json({ error: "A vt.edu email address is required" });
    return;
  }

  const name = asString(claims.name ?? claims.full_name) || email.split("@")[0];
  const existing = await pool.query<MemberRow>("SELECT * FROM pgn_users WHERE clerk_id = $1", [clerkId]);
  if (existing.rows[0]) {
    req.member = existing.rows[0];
  } else {
    const preapproved = await pool.query<MemberRow>(
      "SELECT * FROM pgn_users WHERE lower(email) = $1 AND clerk_id LIKE 'preapproved:%' AND status = 'active'",
      [email],
    );
    if (preapproved.rows[0]) {
      const linked = await pool.query<MemberRow>(
        "UPDATE pgn_users SET clerk_id=$1, name=$2 WHERE id=$3 RETURNING *",
        [clerkId, name, preapproved.rows[0].id],
      );
      req.member = linked.rows[0];
    } else {
      const count = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM pgn_users");
      const isFirst = Number(count.rows[0]?.count ?? 0) === 0;
      const inserted = await pool.query<MemberRow>(
        "INSERT INTO pgn_users (clerk_id, name, email, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [clerkId, name, email, isFirst ? "super_admin" : "pending", isFirst ? "active" : "pending"],
      );
      req.member = inserted.rows[0];
    }
  }
  next();
}

function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.member || !roles.includes(req.member.role)) {
      res.status(403).json({ error: "You do not have permission to do that" });
      return;
    }
    next();
  };
}

async function logActivity(actor: MemberRow, action: string, target: string): Promise<void> {
  await pool.query("INSERT INTO pgn_activity (actor_name, action, target) VALUES ($1, $2, $3)", [actor.name, action, target]);
}

async function selectPnm(id: number) {
  const result = await pool.query(
    `SELECT p.*, AVG(v.score) AS average_vote, COUNT(v.id)::int AS vote_count
     FROM pgn_pnms p LEFT JOIN pgn_votes v ON v.pnm_id = p.id
     WHERE p.id = $1 GROUP BY p.id`,
    [id],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

router.post("/access/invite", async (req, res): Promise<void> => {
  const parsed = ValidateInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter an invite code" });
    return;
  }
  const result = await pool.query("SELECT label FROM pgn_invites WHERE code = $1 AND active = true", [parsed.data.code.trim()]);
  res.json({ valid: Boolean(result.rows[0]), label: result.rows[0]?.label ?? null });
});

router.use(ensureMember);

router.get("/me", (req: AuthedRequest, res) => {
  res.json(memberView(req.member!));
});

router.use((req: AuthedRequest, res: Response, next: NextFunction): void => {
  if (req.member?.status !== "active") {
    res.status(403).json({ error: "Your chapter account is awaiting approval" });
    return;
  }
  next();
});

router.get("/dashboard", async (_req, res): Promise<void> => {
  const [total, active, pending, pipeline, rounds] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM pgn_pnms"),
    pool.query("SELECT COUNT(*)::int AS count FROM pgn_pnms WHERE archived = false"),
    pool.query("SELECT COUNT(*)::int AS count FROM pgn_users WHERE role = 'pending'"),
    pool.query("SELECT status, COUNT(*)::int AS count FROM pgn_pnms WHERE archived = false GROUP BY status ORDER BY status"),
    pool.query(`SELECT r.*, COUNT(v.id)::int AS vote_count FROM pgn_voting_rounds r
      LEFT JOIN pgn_votes v ON v.round_id = r.id WHERE r.status = 'open'
      GROUP BY r.id ORDER BY r.opened_at DESC`),
  ]);
  const user = (_req as AuthedRequest).member!;
  const outstanding = await pool.query(
    `SELECT COUNT(*)::int AS count FROM pgn_voting_rounds r
     JOIN LATERAL unnest(r.pnm_ids) AS ids(pnm_id) ON true
     WHERE r.status = 'open'
     AND NOT EXISTS (SELECT 1 FROM pgn_votes v WHERE v.round_id = r.id AND v.pnm_id = ids.pnm_id AND v.voter_id = $1)`,
    [user.id],
  );
  res.json({
    totalPnms: Number(total.rows[0]?.count ?? 0),
    activePnms: Number(active.rows[0]?.count ?? 0),
    pendingApprovals: Number(pending.rows[0]?.count ?? 0),
    pipeline: pipeline.rows,
    openRounds: rounds.rows.map((round) => ({
      id: round.id, name: round.name, status: round.status, pnmIds: round.pnm_ids,
      deadline: round.deadline?.toISOString?.() ?? round.deadline ?? null,
      openedAt: new Date(round.opened_at).toISOString(), closedAt: null, voteCount: Number(round.vote_count ?? 0),
    })),
    outstandingVotes: Number(outstanding.rows[0]?.count ?? 0),
  });
});

router.get("/pnms", async (req, res): Promise<void> => {
  const parsed = ListPnmsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const query = parsed.data;
  const values: unknown[] = [];
  const where = ["p.archived = $" + (values.push(query.archived ?? false) as number)];
  if (query.search) {
    values.push(`%${query.search.trim()}%`);
    where.push(`(p.first_name ILIKE $${values.length} OR p.last_name ILIKE $${values.length} OR p.email ILIKE $${values.length})`);
  }
  if (query.year) { values.push(query.year); where.push(`p.year = $${values.length}`); }
  if (query.major) { values.push(query.major); where.push(`p.major = $${values.length}`); }
  if (query.status) { values.push(query.status); where.push(`p.status = $${values.length}`); }
  const sortMap: Record<string, string> = { name: "p.last_name, p.first_name", year: "p.year", major: "p.major", status: "p.status", score: "average_vote DESC NULLS LAST" };
  const order = sortMap[query.sort ?? "name"] ?? sortMap.name;
  const result = await pool.query(
    `SELECT p.*, AVG(v.score) AS average_vote, COUNT(v.id)::int AS vote_count
     FROM pgn_pnms p LEFT JOIN pgn_votes v ON v.pnm_id = p.id
     WHERE ${where.join(" AND ")} GROUP BY p.id ORDER BY ${order}`,
    values,
  );
  res.json(result.rows.map(pnmView));
});

router.post("/pnms", requireRole("super_admin", "admin"), async (req: AuthedRequest, res): Promise<void> => {
  const parsed = CreatePnmBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const p = parsed.data;
  const inserted = await pool.query(
    `INSERT INTO pgn_pnms (first_name,last_name,pronouns,email,year,major,minor,gpa,photo_path,status,semester)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [p.firstName.trim(), p.lastName.trim(), p.pronouns || null, p.email || null, p.year || null, p.major || null, p.minor || null, p.gpa ?? null, p.photoPath || null, p.status ?? "new", p.semester || null],
  );
  await logActivity(req.member!, "Added PNM", `${p.firstName} ${p.lastName}`);
  res.status(201).json(pnmView({ ...inserted.rows[0], average_vote: null, vote_count: 0 }));
});

router.post("/pnms/import", requireRole("super_admin", "admin"), async (req: AuthedRequest, res): Promise<void> => {
  const parsed = ImportPnmsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const lines = parsed.data.csv.replace(/\r/g, "").split("\n");
  const headers = (lines.shift() ?? "").split(",").map((header) => header.trim().toLowerCase());
  const expected = ["first_name", "last_name", "pronouns", "email", "year", "major", "minor", "gpa"];
  const errors: { row: number; message: string }[] = [];
  let imported = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const cells = line.split(",").map((cell) => cell.trim());
    const row: Record<string, string> = {};
    headers.forEach((header, cellIndex) => { row[header] = cells[cellIndex] ?? ""; });
    const missing = expected.filter((header) => !(header in row));
    if (missing.length) { errors.push({ row: index + 2, message: `Missing columns: ${missing.join(", ")}` }); continue; }
    if (!row.first_name || !row.last_name) { errors.push({ row: index + 2, message: "first_name and last_name are required" }); continue; }
    const gpa = row.gpa ? Number(row.gpa) : null;
    if (gpa !== null && (!Number.isFinite(gpa) || gpa < 0 || gpa > 4)) { errors.push({ row: index + 2, message: "gpa must be a number from 0.0 to 4.0" }); continue; }
    if (row.email && !row.email.includes("@")) { errors.push({ row: index + 2, message: "email must be a valid email address" }); continue; }
    await pool.query(
      `INSERT INTO pgn_pnms (first_name,last_name,pronouns,email,year,major,minor,gpa,semester)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.first_name, row.last_name, row.pronouns || null, row.email || null, row.year || null, row.major || null, row.minor || null, gpa, parsed.data.semester || null],
    );
    imported += 1;
  }
  await logActivity(req.member!, "Imported PNMs", `${imported} imported`);
  res.json({ imported, errors });
});

router.get("/pnms/:id", async (req, res): Promise<void> => {
  const parsed = GetPnmParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const pnm = await selectPnm(parsed.data.id);
  if (!pnm) { res.status(404).json({ error: "PNM not found" }); return; }
  res.json(pnmView(pnm));
});

router.patch("/pnms/:id", requireRole("super_admin", "admin"), async (req: AuthedRequest, res): Promise<void> => {
  const params = UpdatePnmParams.safeParse(req.params);
  const parsed = UpdatePnmBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Invalid PNM data" }); return; }
  const p = parsed.data;
  const updated = await pool.query(
    `UPDATE pgn_pnms SET first_name=$1,last_name=$2,pronouns=$3,email=$4,year=$5,major=$6,minor=$7,gpa=$8,photo_path=$9,status=$10,semester=$11,updated_at=NOW()
     WHERE id=$12 RETURNING *`,
    [p.firstName, p.lastName, p.pronouns || null, p.email || null, p.year || null, p.major || null, p.minor || null, p.gpa ?? null, p.photoPath || null, p.status ?? "new", p.semester || null, params.data.id],
  );
  if (!updated.rows[0]) { res.status(404).json({ error: "PNM not found" }); return; }
  await logActivity(req.member!, "Updated PNM", `${p.firstName} ${p.lastName}`);
  res.json(pnmView({ ...updated.rows[0], average_vote: null, vote_count: 0 }));
});

router.delete("/pnms/:id", requireRole("super_admin", "admin"), async (req: AuthedRequest, res): Promise<void> => {
  const params = DeletePnmParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const deleted = await pool.query("DELETE FROM pgn_pnms WHERE id = $1 RETURNING first_name, last_name", [params.data.id]);
  if (!deleted.rows[0]) { res.status(404).json({ error: "PNM not found" }); return; }
  await logActivity(req.member!, "Deleted PNM", `${deleted.rows[0].first_name} ${deleted.rows[0].last_name}`);
  res.status(204).send();
});

router.get("/pnms/:id/notes", async (req, res): Promise<void> => {
  const params = ListNotesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const result = await pool.query("SELECT * FROM pgn_notes WHERE pnm_id = $1 ORDER BY pinned DESC, created_at DESC", [params.data.id]);
  res.json(result.rows.map((note) => ({ id: note.id, pnmId: note.pnm_id, authorName: note.author_name, content: note.content, pinned: note.pinned, createdAt: new Date(note.created_at).toISOString() })));
});

router.post("/pnms/:id/notes", async (req: AuthedRequest, res): Promise<void> => {
  const params = CreateNoteParams.safeParse(req.params);
  const parsed = CreateNoteBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Note cannot be empty" }); return; }
  const result = await pool.query("INSERT INTO pgn_notes (pnm_id, author_id, author_name, content) VALUES ($1,$2,$3,$4) RETURNING *", [params.data.id, req.member!.id, req.member!.name, parsed.data.content.trim()]);
  const note = result.rows[0];
  res.status(201).json({ id: note.id, pnmId: note.pnm_id, authorName: note.author_name, content: note.content, pinned: note.pinned, createdAt: new Date(note.created_at).toISOString() });
});

router.patch("/notes/:id/pin", requireRole("super_admin", "admin"), async (req, res): Promise<void> => {
  const params = ToggleNotePinParams.safeParse(req.params);
  const parsed = ToggleNotePinBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Invalid pin state" }); return; }
  const result = await pool.query("UPDATE pgn_notes SET pinned = $1 WHERE id = $2 RETURNING *", [parsed.data.pinned, params.data.id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Note not found" }); return; }
  const note = result.rows[0];
  res.json({ id: note.id, pnmId: note.pnm_id, authorName: note.author_name, content: note.content, pinned: note.pinned, createdAt: new Date(note.created_at).toISOString() });
});

router.get("/voting/rounds", async (req, res): Promise<void> => {
  const result = await pool.query(`SELECT r.*, COUNT(v.id)::int AS vote_count FROM pgn_voting_rounds r LEFT JOIN pgn_votes v ON v.round_id = r.id GROUP BY r.id ORDER BY r.opened_at DESC`);
  res.json(result.rows.map((round) => ({
    id: round.id, name: round.name, status: round.status, pnmIds: round.pnm_ids, deadline: round.deadline?.toISOString?.() ?? round.deadline ?? null,
    openedAt: new Date(round.opened_at).toISOString(), closedAt: round.closed_at ? new Date(round.closed_at).toISOString() : null, voteCount: Number(round.vote_count ?? 0),
  })));
});

router.post("/voting/rounds", requireRole("super_admin", "admin"), async (req, res): Promise<void> => {
  const parsed = CreateVotingRoundBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const result = await pool.query("INSERT INTO pgn_voting_rounds (name, pnm_ids, deadline) VALUES ($1,$2,$3) RETURNING *", [parsed.data.name, parsed.data.pnmIds, parsed.data.deadline ?? null]);
  const round = result.rows[0];
  res.status(201).json({ id: round.id, name: round.name, status: round.status, pnmIds: round.pnm_ids, deadline: round.deadline?.toISOString?.() ?? null, openedAt: new Date(round.opened_at).toISOString(), closedAt: null, voteCount: 0 });
});

router.get("/voting/rounds/:id", async (req: AuthedRequest, res): Promise<void> => {
  const params = GetVotingRoundParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const roundResult = await pool.query("SELECT * FROM pgn_voting_rounds WHERE id = $1", [params.data.id]);
  const round = roundResult.rows[0];
  if (!round) { res.status(404).json({ error: "Voting round not found" }); return; }
  const results = await pool.query(
    `SELECT p.id AS pnm_id, p.first_name || ' ' || p.last_name AS pnm_name, AVG(v.score) AS average, COUNT(v.id)::int AS vote_count
     FROM pgn_pnms p LEFT JOIN pgn_votes v ON v.pnm_id = p.id AND v.round_id = $1
     WHERE p.id = ANY($2::int[]) GROUP BY p.id ORDER BY p.last_name`,
    [round.id, round.pnm_ids],
  );
  const isAdmin = req.member!.role === "admin" || req.member!.role === "super_admin";
  const detail = await Promise.all(results.rows.map(async (row) => {
    const item: Record<string, unknown> = { pnmId: row.pnm_id, pnmName: row.pnm_name, average: row.average == null ? null : Number(Number(row.average).toFixed(2)), voteCount: Number(row.vote_count) };
    if (isAdmin) {
      const votes = await pool.query("SELECT v.score, u.name AS member_name, v.created_at FROM pgn_votes v JOIN pgn_users u ON u.id = v.voter_id WHERE v.round_id = $1 AND v.pnm_id = $2 ORDER BY v.created_at", [round.id, row.pnm_id]);
      item.votes = votes.rows.map((vote) => ({ score: vote.score, memberName: vote.member_name, createdAt: new Date(vote.created_at).toISOString() }));
    }
    return item;
  }));
  res.json({ id: round.id, name: round.name, status: round.status, pnmIds: round.pnm_ids, deadline: round.deadline?.toISOString?.() ?? null, openedAt: new Date(round.opened_at).toISOString(), closedAt: round.closed_at ? new Date(round.closed_at).toISOString() : null, voteCount: results.rows.reduce((total, row) => total + Number(row.vote_count), 0), results });
});

router.post("/voting/rounds/:id/close", requireRole("super_admin", "admin"), async (req, res): Promise<void> => {
  const params = CloseVotingRoundParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const result = await pool.query("UPDATE pgn_voting_rounds SET status='closed', closed_at=NOW() WHERE id=$1 RETURNING *", [params.data.id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Voting round not found" }); return; }
  const round = result.rows[0];
  res.json({ id: round.id, name: round.name, status: round.status, pnmIds: round.pnm_ids, deadline: round.deadline?.toISOString?.() ?? null, openedAt: new Date(round.opened_at).toISOString(), closedAt: new Date(round.closed_at).toISOString(), voteCount: 0 });
});

router.post("/voting/rounds/:id/votes", async (req: AuthedRequest, res): Promise<void> => {
  const params = CastVoteParams.safeParse(req.params);
  const parsed = CastVoteBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Vote must be between 1 and 5" }); return; }
  const round = await pool.query("SELECT * FROM pgn_voting_rounds WHERE id=$1", [params.data.id]);
  if (!round.rows[0] || round.rows[0].status !== "open") { res.status(409).json({ error: "This voting round is closed" }); return; }
  if (!(round.rows[0].pnm_ids as number[]).includes(parsed.data.pnmId)) { res.status(400).json({ error: "PNM is not part of this round" }); return; }
  await pool.query(
    `INSERT INTO pgn_votes (round_id,pnm_id,voter_id,score) VALUES ($1,$2,$3,$4)
     ON CONFLICT (round_id,pnm_id,voter_id) DO UPDATE SET score=EXCLUDED.score, created_at=NOW()`,
    [params.data.id, parsed.data.pnmId, req.member!.id, parsed.data.score],
  );
  res.status(201).json({ roundId: params.data.id, pnmId: parsed.data.pnmId, score: parsed.data.score, saved: true });
});

router.get("/approvals", requireRole("super_admin", "admin"), async (_req, res): Promise<void> => {
  const result = await pool.query("SELECT id, name, email, created_at FROM pgn_users WHERE role='pending' ORDER BY created_at");
  res.json(result.rows.map((row) => ({ id: row.id, name: row.name, email: row.email, requestedAt: new Date(row.created_at).toISOString(), inviteLabel: null })));
});

router.post("/approvals/:id/approve", requireRole("super_admin", "admin"), async (req: AuthedRequest, res): Promise<void> => {
  const params = ApproveMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid member" }); return; }
  const result = await pool.query("UPDATE pgn_users SET role='member', status='active' WHERE id=$1 AND role='pending' RETURNING *", [params.data.id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Pending member not found" }); return; }
  await logActivity(req.member!, "Approved member", result.rows[0].email);
  res.json(memberView(result.rows[0]));
});

router.post("/approvals/:id/reject", requireRole("super_admin", "admin"), async (req: AuthedRequest, res): Promise<void> => {
  const params = RejectMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid member" }); return; }
  await pool.query("UPDATE pgn_users SET status='rejected' WHERE id=$1 AND role='pending'", [params.data.id]);
  await logActivity(req.member!, "Rejected member", String(params.data.id));
  res.status(204).send();
});

router.get("/users", requireRole("super_admin", "admin"), async (_req, res): Promise<void> => {
  const result = await pool.query<MemberRow>("SELECT * FROM pgn_users WHERE status='active' ORDER BY name");
  res.json(result.rows.map(memberView));
});

router.post("/users", requireRole("super_admin", "admin"), async (req: AuthedRequest, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.email.toLowerCase().endsWith("@vt.edu")) {
    res.status(400).json({ error: "Name and a vt.edu email address are required" });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const existing = await pool.query("SELECT id FROM pgn_users WHERE lower(email) = $1", [email]);
  if (existing.rows[0]) {
    res.status(409).json({ error: "A member with that email already exists" });
    return;
  }
  const result = await pool.query<MemberRow>(
    "INSERT INTO pgn_users (clerk_id, name, email, role, status) VALUES ($1, $2, $3, 'member', 'active') RETURNING *",
    [`preapproved:${email}`, parsed.data.name.trim(), email],
  );
  await logActivity(req.member!, "Added member", email);
  res.status(201).json(memberView(result.rows[0]));
});

router.patch("/users/:id/role", requireRole("super_admin"), async (req: AuthedRequest, res): Promise<void> => {
  const params = UpdateUserRoleParams.safeParse(req.params);
  const parsed = UpdateUserRoleBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Invalid role" }); return; }
  const target = await pool.query<MemberRow>("SELECT * FROM pgn_users WHERE id=$1", [params.data.id]);
  if (!target.rows[0] || target.rows[0].role === "super_admin") { res.status(403).json({ error: "The Super Admin cannot be changed" }); return; }
  const result = await pool.query<MemberRow>("UPDATE pgn_users SET role=$1 WHERE id=$2 RETURNING *", [parsed.data.role, params.data.id]);
  await logActivity(req.member!, `${parsed.data.role === "admin" ? "Promoted" : "Demoted"} user`, result.rows[0].email);
  res.json(memberView(result.rows[0]));
});

router.get("/activity", requireRole("super_admin", "admin"), async (req, res): Promise<void> => {
  const parsed = ListActivityQueryParams.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit ?? 50 : 50;
  const result = await pool.query("SELECT * FROM pgn_activity ORDER BY created_at DESC LIMIT $1", [limit]);
  res.json(result.rows.map((row) => ({ id: row.id, actorName: row.actor_name, action: row.action, target: row.target, createdAt: new Date(row.created_at).toISOString() })));
});

export default router;
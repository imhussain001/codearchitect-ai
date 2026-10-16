import type { ArchitectureGraph } from "@/lib/types";
import { makeNode } from "@/lib/mock/makeNode";

const dashboard = makeNode("dashboard", { x: 260, y: 0 }, {
  label: "User Dashboard",
  kind: "frontend",
  filePath: "src/app/dashboard/page.tsx",
  description: "Server component that renders the signed-in user's profile and active sessions.",
  language: "tsx",
  exports: ["default DashboardPage"],
  imports: ["@/lib/api/session"],
  params: [{ name: "searchParams", type: "{ tab?: string }", description: "Selected dashboard tab" }],
  keywords: ["dashboard", "ui", "profile", "frontend", "page"],
  code: `import { getSession } from "@/lib/api/session";

type SessionUser = {
  userId: number;
  email: string;
  displayName: string;
};

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) return <SignInPrompt />;

  const user: SessionUser = session.user;
  return (
    <main className="dashboard">
      <h1>Welcome back, {user.displayName}</h1>
      <ProfileCard userId={user.userId} email={user.email} />
      <ActiveSessions userId={user.userId} />
    </main>
  );
}`,
});

const sessionRoute = makeNode("session-api", { x: 260, y: 170 }, {
  label: "GET /api/session",
  kind: "api",
  filePath: "src/app/api/session/route.ts",
  description: "Validates the bearer token and returns the current user's session payload.",
  language: "ts",
  exports: ["GET"],
  imports: ["@/server/auth/controller"],
  params: [{ name: "Authorization", type: "header: Bearer <jwt>" }],
  keywords: ["session", "route", "endpoint", "api", "bearer"],
  code: `import { NextResponse } from "next/server";
import { authController } from "@/server/auth/controller";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 401 });
  }

  const session = await authController.resolveSession(token);
  if (!session) {
    return NextResponse.json({ error: "invalid session" }, { status: 401 });
  }

  const userId: number = session.user.userId;
  return NextResponse.json({ user: session.user, userId });
}`,
});

const authController = makeNode("auth-controller", { x: 260, y: 340 }, {
  label: "Auth Controller",
  kind: "logic",
  filePath: "src/server/auth/controller.ts",
  description: "Orchestrates login and session resolution across the JWT service and the users table.",
  language: "ts",
  exports: ["authController", "SessionPayload"],
  imports: ["@/server/auth/jwt", "@/server/db/users"],
  params: [
    { name: "token", type: "string", description: "Signed access token" },
    { name: "credentials", type: "{ email: string; password: string }" },
  ],
  keywords: ["auth", "controller", "login", "session", "authentication"],
  code: `import { jwtService } from "@/server/auth/jwt";
import { usersRepo, type UserRow } from "@/server/db/users";

export type SessionPayload = { user: Pick<UserRow, "userId" | "email" | "displayName"> };

export const authController = {
  async login(email: string, password: string): Promise<string | null> {
    const user = await usersRepo.findByEmail(email);
    if (!user || !(await usersRepo.verifyPassword(user, password))) return null;
    return jwtService.sign({ sub: user.userId });
  },

  async resolveSession(token: string): Promise<SessionPayload | null> {
    const claims = await jwtService.verify(token);
    if (!claims) return null;

    const userId = Number(claims.sub);
    const user = await usersRepo.findById(userId);
    return user ? { user } : null;
  },
};`,
});

const jwtService = makeNode("jwt-service", { x: 40, y: 520 }, {
  label: "JWT Service",
  kind: "logic",
  filePath: "src/server/auth/jwt.ts",
  description: "Signs and verifies HS256 access tokens; caches revocations in Redis.",
  language: "ts",
  exports: ["jwtService", "AccessClaims"],
  imports: ["jose", "@/server/cache/sessions"],
  params: [{ name: "claims", type: "AccessClaims" }],
  keywords: ["jwt", "token", "sign", "verify", "claims", "hs256", "rs256"],
  code: `import { SignJWT, jwtVerify } from "jose";
import { sessionCache } from "@/server/cache/sessions";

export type AccessClaims = { sub: number };

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const ACCESS_TOKEN_TTL = "15m";

export const jwtService = {
  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sub: String(claims.sub) })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(ACCESS_TOKEN_TTL)
      .sign(SECRET);
  },

  async verify(token: string): Promise<{ sub: string } | null> {
    if (await sessionCache.isRevoked(token)) return null;
    const { payload } = await jwtVerify(token, SECRET);
    return payload.sub ? { sub: payload.sub } : null;
  },
};`,
});

const usersDb = makeNode("users-db", { x: 480, y: 520 }, {
  label: "Users Database",
  kind: "data",
  filePath: "src/server/db/users.ts",
  description: "PostgreSQL `users` table and its repository (raw SQL via node-postgres).",
  language: "ts",
  exports: ["usersRepo", "UserRow"],
  imports: ["pg", "bcrypt"],
  params: [{ name: "userId", type: "number (SERIAL)" }],
  keywords: ["database", "db", "users", "schema", "postgres", "sql", "table", "userid", "repository"],
  code: `import { Pool } from "pg";
import bcrypt from "bcrypt";

// CREATE TABLE users (
//   user_id      SERIAL PRIMARY KEY,
//   email        TEXT UNIQUE NOT NULL,
//   display_name TEXT NOT NULL,
//   password     TEXT NOT NULL
// );

export type UserRow = { userId: number; email: string; displayName: string; password: string };

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const usersRepo = {
  async findById(userId: number): Promise<UserRow | null> {
    const { rows } = await pool.query("SELECT * FROM users WHERE user_id = $1", [userId]);
    return rows[0] ?? null;
  },

  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    return rows[0] ?? null;
  },

  verifyPassword(user: UserRow, plain: string): Promise<boolean> {
    return bcrypt.compare(plain, user.password);
  },
};`,
});

const sessionCache = makeNode("session-cache", { x: 40, y: 700 }, {
  label: "Session Cache (Redis)",
  kind: "data",
  filePath: "src/server/cache/sessions.ts",
  description: "Redis set of revoked token IDs; read on every token verification.",
  language: "ts",
  exports: ["sessionCache"],
  imports: ["ioredis"],
  params: [{ name: "token", type: "string" }],
  keywords: ["redis", "cache", "session", "revocation", "logout"],
  code: `import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);
const REVOKED_KEY = "auth:revoked";

export const sessionCache = {
  async revoke(token: string): Promise<void> {
    await redis.sadd(REVOKED_KEY, token);
  },

  async isRevoked(token: string): Promise<boolean> {
    return (await redis.sismember(REVOKED_KEY, token)) === 1;
  },
};`,
});

export const authMicroservice: ArchitectureGraph = {
  id: "auth-microservice",
  name: "Auth Microservice",
  description: "Next.js auth service: session API, JWT issuance, Postgres users and Redis revocation list.",
  nodes: [dashboard, sessionRoute, authController, jwtService, usersDb, sessionCache],
  edges: [
    { id: "e-dash-api", source: "dashboard", target: "session-api", relation: "calls", label: "fetch session" },
    { id: "e-api-ctrl", source: "session-api", target: "auth-controller", relation: "calls", label: "resolveSession()" },
    { id: "e-ctrl-jwt", source: "auth-controller", target: "jwt-service", relation: "calls", label: "sign / verify" },
    { id: "e-ctrl-db", source: "auth-controller", target: "users-db", relation: "reads", label: "findById()" },
    { id: "e-jwt-cache", source: "jwt-service", target: "session-cache", relation: "reads", label: "isRevoked()" },
  ],
  commits: [
    {
      hash: "a1f3c09",
      message: "feat(auth): bootstrap users table and login controller",
      author: "maria.k",
      date: "2026-03-02",
      phase: "Phase 1 · Foundations",
      narrative:
        "The service starts as a classic three-layer slice: a Postgres users table, a controller that checks bcrypt hashes, and nothing else. Sessions are not yet a concept — login simply returns a success flag.",
      addedNodeIds: ["users-db", "auth-controller"],
      modifiedNodeIds: [],
    },
    {
      hash: "4be771d",
      message: "feat(auth): stateless JWT sessions + /api/session endpoint",
      author: "maria.k",
      date: "2026-03-19",
      phase: "Phase 2 · Stateless sessions",
      narrative:
        "To let the new dashboard authenticate without sticky sessions, the team introduces HS256 JWTs and a session endpoint. The controller now depends on both the token service and the users table — the first fan-out in the graph.",
      addedNodeIds: ["jwt-service", "session-api", "dashboard"],
      modifiedNodeIds: ["auth-controller"],
    },
    {
      hash: "9c02e5a",
      message: "perf(auth): Redis revocation list (p95 verify latency 180ms → 12ms)",
      author: "dev.okafor",
      date: "2026-05-07",
      phase: "Phase 3 · Redis cache",
      narrative:
        "Logout needed real revocation, and checking a Postgres table on every request pushed p95 verification latency to 180 ms. A Redis set replaces the lookup. The JWT service gains its first infrastructure dependency.",
      addedNodeIds: ["session-cache"],
      modifiedNodeIds: ["jwt-service"],
    },
    {
      hash: "e77d410",
      message: "fix(session): coerce sub claim to number — dashboard showed stale user",
      author: "dev.okafor",
      date: "2026-06-21",
      phase: "Phase 4 · Session regression",
      narrative:
        "JWT `sub` claims are strings, but the users table keys on integers. A strict-equality check silently failed and the dashboard rendered a cached profile. The hotfix adds `Number(claims.sub)` in the controller — a coupling worth remembering before any user-ID migration.",
      addedNodeIds: [],
      modifiedNodeIds: ["auth-controller", "session-api", "dashboard"],
    },
  ],
  scenarios: [
    {
      id: "auth-userid-uuid",
      title: "Migrate userId from integer to UUID v4",
      triggers: ["uuid", "user_?id.*(string|uuid)", "integer.*uuid"],
      rootNodeId: "users-db",
      summary:
        "Changing the users primary key from SERIAL to UUID v4 alters the `UserRow.userId` type. Every consumer that does numeric coercion (`Number(claims.sub)`) or types the ID as `number` breaks at compile time; the JWT `sub` claim no longer needs coercion.",
      extraImpacts: [
        { nodeId: "jwt-service", reason: "`AccessClaims.sub` is typed `number`; UUIDs must be carried as strings." },
      ],
      diffs: [
        {
          nodeId: "users-db",
          rationale: "Switch the key to UUID with a database-side default and update the row type.",
          after: `import { Pool } from "pg";
import bcrypt from "bcrypt";

// CREATE TABLE users (
//   user_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   email        TEXT UNIQUE NOT NULL,
//   display_name TEXT NOT NULL,
//   password     TEXT NOT NULL
// );

export type UserRow = { userId: string; email: string; displayName: string; password: string };

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const usersRepo = {
  async findById(userId: string): Promise<UserRow | null> {
    const { rows } = await pool.query("SELECT * FROM users WHERE user_id = $1::uuid", [userId]);
    return rows[0] ?? null;
  },

  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    return rows[0] ?? null;
  },

  verifyPassword(user: UserRow, plain: string): Promise<boolean> {
    return bcrypt.compare(plain, user.password);
  },
};`,
        },
        {
          nodeId: "auth-controller",
          rationale: "Remove the numeric coercion added in e77d410; the claim is now the UUID string.",
          after: `import { jwtService } from "@/server/auth/jwt";
import { usersRepo, type UserRow } from "@/server/db/users";

export type SessionPayload = { user: Pick<UserRow, "userId" | "email" | "displayName"> };

export const authController = {
  async login(email: string, password: string): Promise<string | null> {
    const user = await usersRepo.findByEmail(email);
    if (!user || !(await usersRepo.verifyPassword(user, password))) return null;
    return jwtService.sign({ sub: user.userId });
  },

  async resolveSession(token: string): Promise<SessionPayload | null> {
    const claims = await jwtService.verify(token);
    if (!claims) return null;

    const user = await usersRepo.findById(claims.sub);
    return user ? { user } : null;
  },
};`,
        },
        {
          nodeId: "jwt-service",
          rationale: "Carry the UUID directly in `sub`; no string conversion needed.",
          after: `import { SignJWT, jwtVerify } from "jose";
import { sessionCache } from "@/server/cache/sessions";

export type AccessClaims = { sub: string };

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const ACCESS_TOKEN_TTL = "15m";

export const jwtService = {
  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sub: claims.sub })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(ACCESS_TOKEN_TTL)
      .sign(SECRET);
  },

  async verify(token: string): Promise<{ sub: string } | null> {
    if (await sessionCache.isRevoked(token)) return null;
    const { payload } = await jwtVerify(token, SECRET);
    return payload.sub ? { sub: payload.sub } : null;
  },
};`,
        },
        {
          nodeId: "session-api",
          rationale: "Response contract changes: `userId` is now a string.",
          after: `import { NextResponse } from "next/server";
import { authController } from "@/server/auth/controller";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 401 });
  }

  const session = await authController.resolveSession(token);
  if (!session) {
    return NextResponse.json({ error: "invalid session" }, { status: 401 });
  }

  const userId: string = session.user.userId;
  return NextResponse.json({ user: session.user, userId });
}`,
        },
        {
          nodeId: "dashboard",
          rationale: "Update the client-side type so child components receive a string ID.",
          after: `import { getSession } from "@/lib/api/session";

type SessionUser = {
  userId: string;
  email: string;
  displayName: string;
};

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) return <SignInPrompt />;

  const user: SessionUser = session.user;
  return (
    <main className="dashboard">
      <h1>Welcome back, {user.displayName}</h1>
      <ProfileCard userId={user.userId} email={user.email} />
      <ActiveSessions userId={user.userId} />
    </main>
  );
}`,
        },
      ],
    },
    {
      id: "auth-sql-to-mongo",
      title: "Refactor Users Database from SQL to MongoDB",
      triggers: ["mongo", "nosql", "document (db|store)", "sql to"],
      rootNodeId: "users-db",
      summary:
        "Replacing node-postgres with the MongoDB driver changes the repository's internals and the primary key type (`ObjectId`). The repository interface can be preserved, so the controller needs only an ID-type change, but every consumer typing `userId` as a number breaks.",
      extraImpacts: [
        { nodeId: "jwt-service", reason: "`sub` must carry the ObjectId hex string instead of a number." },
      ],
      diffs: [
        {
          nodeId: "users-db",
          rationale: "Swap the pg Pool for a MongoClient collection while keeping the `usersRepo` surface stable.",
          after: `import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcrypt";

export type UserRow = { userId: string; email: string; displayName: string; password: string };
type UserDoc = { _id: ObjectId; email: string; displayName: string; password: string };

const client = new MongoClient(process.env.MONGODB_URL!);
const users = client.db("auth").collection<UserDoc>("users");

const toRow = (doc: UserDoc): UserRow => ({
  userId: doc._id.toHexString(),
  email: doc.email,
  displayName: doc.displayName,
  password: doc.password,
});

export const usersRepo = {
  async findById(userId: string): Promise<UserRow | null> {
    if (!ObjectId.isValid(userId)) return null;
    const doc = await users.findOne({ _id: new ObjectId(userId) });
    return doc ? toRow(doc) : null;
  },

  async findByEmail(email: string): Promise<UserRow | null> {
    const doc = await users.findOne({ email });
    return doc ? toRow(doc) : null;
  },

  verifyPassword(user: UserRow, plain: string): Promise<boolean> {
    return bcrypt.compare(plain, user.password);
  },
};`,
        },
        {
          nodeId: "auth-controller",
          rationale: "Drop `Number()` coercion; IDs are ObjectId hex strings.",
          after: `import { jwtService } from "@/server/auth/jwt";
import { usersRepo, type UserRow } from "@/server/db/users";

export type SessionPayload = { user: Pick<UserRow, "userId" | "email" | "displayName"> };

export const authController = {
  async login(email: string, password: string): Promise<string | null> {
    const user = await usersRepo.findByEmail(email);
    if (!user || !(await usersRepo.verifyPassword(user, password))) return null;
    return jwtService.sign({ sub: user.userId });
  },

  async resolveSession(token: string): Promise<SessionPayload | null> {
    const claims = await jwtService.verify(token);
    if (!claims) return null;

    const user = await usersRepo.findById(claims.sub);
    return user ? { user } : null;
  },
};`,
        },
        {
          nodeId: "jwt-service",
          rationale: "Type the subject claim as a string.",
          after: `import { SignJWT, jwtVerify } from "jose";
import { sessionCache } from "@/server/cache/sessions";

export type AccessClaims = { sub: string };

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const ACCESS_TOKEN_TTL = "15m";

export const jwtService = {
  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sub: claims.sub })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(ACCESS_TOKEN_TTL)
      .sign(SECRET);
  },

  async verify(token: string): Promise<{ sub: string } | null> {
    if (await sessionCache.isRevoked(token)) return null;
    const { payload } = await jwtVerify(token, SECRET);
    return payload.sub ? { sub: payload.sub } : null;
  },
};`,
        },
        {
          nodeId: "session-api",
          rationale: "`userId` in the response becomes a string.",
          after: `import { NextResponse } from "next/server";
import { authController } from "@/server/auth/controller";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 401 });
  }

  const session = await authController.resolveSession(token);
  if (!session) {
    return NextResponse.json({ error: "invalid session" }, { status: 401 });
  }

  const userId: string = session.user.userId;
  return NextResponse.json({ user: session.user, userId });
}`,
        },
      ],
    },
  ],
};

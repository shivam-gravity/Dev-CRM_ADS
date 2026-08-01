import { randomUUID, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../../db/prisma.js";
import { JWT_SECRET } from "../../infra/env.js";
import { issueRefreshToken } from "./refreshTokenService.js";

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string | null;
  googleId?: string | null;
  createdAt: string;
}

function hashPassword(password: string, salt: string): string {
  return createHash("sha256").update(salt + password + "polluxa-secret").digest("hex");
}

/**
 * The one place an incoming email is canonicalized before it touches the database.
 *
 * Rows are STORED lowercased (register/googleAuth below), but emails arrive from a login form that
 * submits exactly what was typed — and a phone keyboard capitalizes the first letter, while a paste
 * often carries a trailing space. Looking those up verbatim missed the row and reported "Invalid
 * email or password" on a perfectly correct password, which is indistinguishable from a wrong one.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateSalt(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Constant-time comparison of two hex digests. `!==` on the hash leaks, through response timing,
 * how many leading characters a guess got right — enough to walk a digest byte by byte. Length is
 * compared first because timingSafeEqual throws on a length mismatch; digest length isn't secret.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function issueToken(userId: string, workspaceId?: string, businessId?: string): string {
  const payload: Record<string, unknown> = { sub: userId };
  if (workspaceId) payload.workspaceId = workspaceId;
  if (businessId) payload.businessId = businessId;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function toUser(row: { id: string; email: string; name: string; avatar: string | null; googleId: string | null; createdAt: Date }): User {
  return { id: row.id, email: row.email, name: row.name, avatar: row.avatar, googleId: row.googleId, createdAt: row.createdAt.toISOString() };
}

export async function getUserById(id: string): Promise<User | null> {
  const row = await prisma.user.findUnique({ where: { id } });
  return row ? toUser(row) : null;
}

export async function updateUser(id: string, patch: { name?: string; avatar?: string }): Promise<User> {
  const row = await prisma.user.update({ where: { id }, data: patch });
  return toUser(row);
}

/**
 * Resolves an account from a user-supplied email, tolerating the case and whitespace a login form
 * submits verbatim.
 *
 * Two steps on purpose. The normalized `findUnique` is an index hit on `User.email`'s unique
 * constraint and satisfies every row written since registration started lowercasing — i.e. nearly
 * all traffic on a login-path query. Only when that misses do we pay for a case-insensitive scan,
 * which `equals` + `mode: "insensitive"` cannot serve from that index; it exists so rows predating
 * normalization (and anything seeded by hand with mixed case) stay reachable. Oldest-first makes a
 * legacy pair differing only in case resolve to the original account rather than an arbitrary one.
 */
export async function getUserByEmail(email: string): Promise<(User & { passwordHash?: string | null }) | null> {
  const normalized = normalizeEmail(email);
  const row =
    (await prisma.user.findUnique({ where: { email: normalized } })) ??
    (await prisma.user.findFirst({
      where: { email: { equals: normalized, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
    }));
  return row ? { ...toUser(row), passwordHash: row.passwordHash } : null;
}

export interface RegisterInput { email: string; password: string; name: string; }
export interface AuthResult { user: User; token: string; refreshToken: string; workspaceId?: string; businessId?: string; }

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await getUserByEmail(input.email);
  if (existing) throw new Error("Email already in use");

  const salt = generateSalt();
  const passwordHash = `${salt}:${hashPassword(input.password, salt)}`;
  const id = randomUUID();
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  const createdAt = new Date();
  const workspaceId = randomUUID();

  await prisma.$transaction([
    prisma.user.create({ data: { id, email, passwordHash, name, createdAt } }),
    prisma.workspace.create({ data: { id: workspaceId, name: `${name}'s Workspace`, ownerId: id, plan: "starter", createdAt } }),
    prisma.workspaceMember.create({ data: { id: randomUUID(), workspaceId, userId: id, role: "owner", invitedAt: createdAt, joinedAt: createdAt } }),
  ]);

  const user: User = { id, email, name, createdAt: createdAt.toISOString() };
  const token = issueToken(user.id, workspaceId);
  const refreshToken = await issueRefreshToken(user.id);
  return { user, token, refreshToken, workspaceId };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const row = await getUserByEmail(email);
  if (!row) throw new Error("Invalid email or password");

  // A row with NO passwordHash has no local password to check — googleAuth creates exactly that
  // shape. This was previously `if (row.passwordHash) { ...verify... }`, which SKIPPED verification
  // for those accounts entirely and so accepted any password at all; a Google-only user's email was
  // enough to sign in as them. Password login is now refused outright for them, which is the correct
  // answer: their credential is the Google account, and they must use Sign in with Google.
  if (!row.passwordHash) throw new Error("Invalid email or password");
  const [salt, hash] = row.passwordHash.split(":");
  if (!salt || !hash) throw new Error("Invalid email or password");
  if (!timingSafeEqualHex(hashPassword(password, salt), hash)) throw new Error("Invalid email or password");

  const user: User = { id: row.id, email: row.email, name: row.name, avatar: row.avatar, createdAt: row.createdAt };

  const member = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, orderBy: { joinedAt: "asc" } });
  const workspaceId = member?.workspaceId;
  // Surface the workspace's first business (if any) so the web client can resolve businessId at
  // login without a second round-trip. Email/password login previously returned only workspaceId,
  // so a returning production user with an existing business had a null businessId client-side and
  // got bounced to /get-started forever (dev mode hid this via a fake DEMO_BUSINESS_ID). oldest-first
  // matches "your original business" when several exist.
  const firstBusiness = workspaceId
    ? await prisma.business.findFirst({ where: { workspaceId }, orderBy: { createdAt: "asc" }, select: { id: true } })
    : null;
  const businessId = firstBusiness?.id;
  const token = issueToken(user.id, workspaceId, businessId);
  const refreshToken = await issueRefreshToken(user.id);
  return { user, token, refreshToken, workspaceId, businessId };
}

export async function googleAuth(name: string, email: string, googleId: string): Promise<AuthResult> {
  // trim as well as lowercase (normalizeEmail), so a Google profile email with stray whitespace
  // links to the existing local account instead of creating a second, near-identical user.
  const normalizedEmail = normalizeEmail(email);
  let row = await prisma.user.findFirst({
    where: { OR: [{ googleId }, { email: { equals: normalizedEmail, mode: "insensitive" } }] },
    orderBy: { createdAt: "asc" },
  });

  if (!row) {
    const id = randomUUID();
    const createdAt = new Date();
    const workspaceId = randomUUID();

    await prisma.$transaction([
      prisma.user.create({ data: { id, email: normalizedEmail, name, googleId, createdAt } }),
      prisma.workspace.create({ data: { id: workspaceId, name: `${name}'s Workspace`, ownerId: id, plan: "starter", createdAt } }),
      prisma.workspaceMember.create({ data: { id: randomUUID(), workspaceId, userId: id, role: "owner", invitedAt: createdAt, joinedAt: createdAt } }),
    ]);

    const user: User = { id, email: normalizedEmail, name, createdAt: createdAt.toISOString() };
    const token = issueToken(user.id, workspaceId);
    const refreshToken = await issueRefreshToken(user.id);
    return { user, token, refreshToken, workspaceId };
  }

  if (!row.googleId) {
    row = await prisma.user.update({ where: { id: row.id }, data: { googleId } });
  }

  const user = toUser(row);
  const member = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, orderBy: { joinedAt: "asc" } });
  const token = issueToken(user.id, member?.workspaceId);
  const refreshToken = await issueRefreshToken(user.id);
  return { user, token, refreshToken, workspaceId: member?.workspaceId };
}

export function verifyToken(token: string): { userId: string; workspaceId?: string } {
  const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; workspaceId?: string };
  return { userId: decoded.sub, workspaceId: decoded.workspaceId };
}

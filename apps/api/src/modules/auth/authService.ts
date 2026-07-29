import { randomUUID, createHash, randomBytes } from "node:crypto";
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

function generateSalt(): string {
  return randomBytes(16).toString("hex");
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

export async function getUserByEmail(email: string): Promise<(User & { passwordHash?: string | null }) | null> {
  const row = await prisma.user.findUnique({ where: { email } });
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
  const email = input.email.toLowerCase().trim();
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

  if (row.passwordHash) {
    const [salt, hash] = row.passwordHash.split(":");
    if (hashPassword(password, salt) !== hash) throw new Error("Invalid email or password");
  }

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
  const normalizedEmail = email.toLowerCase();
  let row = await prisma.user.findFirst({ where: { OR: [{ googleId }, { email: normalizedEmail }] } });

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

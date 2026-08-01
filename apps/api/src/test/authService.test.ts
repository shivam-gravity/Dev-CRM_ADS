import "dotenv/config";
import { test, after } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { login, register, getUserByEmail } from "../modules/auth/authService.js";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";

after(disconnectTestInfra);

/** register() creates user + workspace + member, and login()/register() mint a refresh token. */
async function purgeUser(userId: string) {
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.workspaceMember.deleteMany({ where: { userId } });
  await prisma.workspace.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

test("login accepts an email typed with different case and stray whitespace", async () => {
  const email = `Case-${randomUUID()}@Example.COM`;
  const password = "0h%Bx}jB*SO}";
  const { user } = await register({ name: "Case Tester", email, password });
  try {
    // Stored lowercased by register, so an exact-match lookup on what the form submitted used to
    // miss the row entirely and report "Invalid email or password" for a correct password.
    assert.strictEqual(user.email, email.toLowerCase(), "register must store the email lowercased");

    for (const typed of [email, email.toLowerCase(), email.toUpperCase(), `  ${email}  `]) {
      const result = await login(typed, password);
      assert.strictEqual(result.user.id, user.id, `login must resolve ${JSON.stringify(typed)} to the same account`);
    }
  } finally {
    await purgeUser(user.id);
  }
});

test("login still rejects a wrong password for an email that resolves", async () => {
  const email = `wrong-${randomUUID()}@example.com`;
  const { user } = await register({ name: "Wrong Pw", email, password: "correct-horse" });
  try {
    await assert.rejects(() => login(email.toUpperCase(), "not-the-password"), /Invalid email or password/);
  } finally {
    await purgeUser(user.id);
  }
});

test("login refuses an account with no passwordHash instead of accepting any password", async () => {
  // The shape googleAuth creates: a real user row with googleId and NO local password. The old
  // `if (row.passwordHash) { ...verify... }` skipped verification for these, so ANY string signed in.
  const id = randomUUID();
  const email = `google-only-${randomUUID()}@example.com`;
  const createdAt = new Date();
  const workspaceId = randomUUID();
  await prisma.$transaction([
    prisma.user.create({ data: { id, email, name: "Google Only", googleId: `g-${id}`, createdAt } }),
    prisma.workspace.create({ data: { id: workspaceId, name: "Google Only's Workspace", ownerId: id, plan: "starter", createdAt } }),
    prisma.workspaceMember.create({ data: { id: randomUUID(), workspaceId, userId: id, role: "owner", invitedAt: createdAt, joinedAt: createdAt } }),
  ]);
  try {
    const stored = await getUserByEmail(email);
    assert.strictEqual(stored?.passwordHash ?? null, null, "fixture must have no passwordHash");

    for (const guess of ["", "anything", "0h%Bx}jB*SO}"]) {
      await assert.rejects(
        () => login(email, guess),
        /Invalid email or password/,
        `a passwordless account must not accept ${JSON.stringify(guess)}`
      );
    }
  } finally {
    await purgeUser(id);
  }
});

test("register rejects a duplicate email that differs only by case", async () => {
  const email = `dupe-${randomUUID()}@example.com`;
  const { user } = await register({ name: "First", email, password: "pw-one" });
  try {
    // The duplicate check used to compare the RAW input, so this slipped past it and then hit the
    // unique constraint on the lowercased insert — surfacing as an opaque failure instead of 409.
    await assert.rejects(
      () => register({ name: "Second", email: email.toUpperCase(), password: "pw-two" }),
      /Email already in use/
    );
  } finally {
    await purgeUser(user.id);
  }
});

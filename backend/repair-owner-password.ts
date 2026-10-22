
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const prisma = new PrismaClient();

const rl = createInterface({ input, output });

async function main() {
  const email = "admin@veyra.test";

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, username: true }
  });

  if (!user) {
    throw new Error("Owner account not found. No changes were made.");
  }

  const password = await rl.question(
    "Enter a NEW password for the Veyra owner account: "
  );

  if (password.length < 12) {
    throw new Error("Use a password with at least 12 characters.");
  }

  const confirmation = await rl.question(
    "Enter the new password again to confirm: "
  );

  if (password !== confirmation) {
    throw new Error("Passwords do not match. No changes were made.");
  }

  const passwordHash = await argon2.hash(password);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash }
  });

  console.log(`Password hash repaired for ${user.email} (${user.username}).`);
}

main()
  .catch((error) => {
    console.error("Password repair failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    rl.close();
    await prisma.$disconnect();
  });

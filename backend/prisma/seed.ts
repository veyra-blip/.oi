import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await argon2.hash("DemoPass123!");
  const pin1 = await argon2.hash("2580");
  const pin2 = await argon2.hash("1357");
  const adminHash = await argon2.hash("AdminPass123!");

  const a = await prisma.user.upsert({
    where: { phone: "08000000001" },
    update: {},
    create: {
      firstName: "Demo",
      lastName: "Sender",
      username: "demo_sender",
      phone: "08000000001",
      email: "demo@example.com",
      passwordHash,
      pinHash: pin1,
      accountNumber: "8100000001"
    }
  });

  const b = await prisma.user.upsert({
    where: { phone: "08000000002" },
    update: {},
    create: {
      firstName: "Demo",
      lastName: "Receiver",
      username: "demo_receiver",
      phone: "08000000002",
      email: "receiver@example.com",
      passwordHash,
      pinHash: pin2,
      accountNumber: "8100000002"
    }
  });

  for (const user of [a, b]) {
    await prisma.wallet.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, balance: 500000000 }
    });
  }

  const admin = await prisma.user.upsert({
    where: { email: "admin@example.com" },
    update: { role: "ADMIN" },
    create: {
      firstName: "System",
      lastName: "Admin",
      username: "system_admin",
      phone: "08000000999",
      email: "admin@example.com",
      passwordHash: adminHash,
      pinHash: await argon2.hash("8642"),
      accountNumber: "8199999999",
      role: "ADMIN"
    }
  });

  await prisma.wallet.upsert({
    where: { userId: admin.id },
    update: {},
    create: { userId: admin.id, balance: 0 }
  });

  const banks = [
    ["Access Bank", "044"],
    ["Guaranty Trust Bank", "058"],
    ["First Bank of Nigeria", "011"],
    ["United Bank for Africa", "033"],
    ["Zenith Bank", "057"],
    ["Fidelity Bank", "070"],
    ["Polaris Bank", "076"],
    ["Moniepoint", "50515"],
    ["Kuda", "090267"]
  ];

  for (const [name, code] of banks) {
    const bank = await prisma.bank.upsert({
      where: { code },
      update: {},
      create: { name, code }
    });

    const existing = await prisma.bankAccount.findFirst({
      where: { bankId: bank.id }
    });

    if (!existing) {
      await prisma.bankAccount.create({
        data: {
          bankId: bank.id,
          accountNumber: `${code}0000001`.slice(0, 10),
          accountName: `TEST ${name.toUpperCase()} RECIPIENT`,
          balance: 10000000
        }
      });
    }
  }

  console.log("Seed complete.");
}

main().finally(() => prisma.$disconnect());

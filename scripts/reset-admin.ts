import { initDB, runWithDB, registerWebUser, migrateFromFile, getAccounts } from "../dist/index.js";
import { createHash, randomBytes } from "crypto";
import { copyFileSync, existsSync } from "fs";

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

async function main() {
  await initDB();

  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();

  // Delete existing admin and all related data
  const old = await p.webUser.findUnique({ where: { username: "admin" } });
  if (old) {
    await p.speaker.deleteMany({ where: { account: { webUserId: old.id } } });
    await p.xiaomiAccount.deleteMany({ where: { webUserId: old.id } });
    await p.authToken.deleteMany({ where: { webUserId: old.id } });
    await p.webUser.delete({ where: { id: old.id } });
    console.log("✅ 已删除旧 admin 用户");
  }

  // Re-register
  const user = await registerWebUser("admin", hashPassword("admin123"));
  if (!user) { console.log("❌ 注册失败"); process.exit(1); }
  console.log("✅ 已创建 admin 用户 (admin123)");

  // Re-run migration
  const migrated = await migrateFromFile(user.id);
  if (migrated) {
    console.log("✅ .migpt.js 配置已导入");
    const accounts = await getAccounts(user.id);
    for (const a of accounts) {
      const miPath = `.mi-${a.id}.json`;
      if (!existsSync(miPath) && existsSync(".mi.json")) {
        copyFileSync(".mi.json", miPath);
        console.log(`✅ .mi.json → ${miPath}`);
      }
    }
  } else {
    console.log("ℹ️  .migpt.js 未找到（可能已迁移过）");
  }

  await p.$disconnect();
  console.log("\n🎉 完成！用 admin / admin123 登录");
}

runWithDB(main);

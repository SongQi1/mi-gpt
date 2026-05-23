import { initDB, runWithDB, registerWebUser, loginWebUser, migrateFromFile, getAccounts } from "../dist/index.js";
import { createHash, randomBytes } from "crypto";
import { copyFileSync, existsSync } from "fs";

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

async function main() {
  await initDB();

  // 1. Create or find admin user
  let user = await loginWebUser("admin");
  if (!user) {
    user = await registerWebUser("admin", hashPassword("admin123"));
    if (!user) {
      console.log("❌ 注册 admin 失败（可能已存在但密码不对）");
      process.exit(1);
    }
    console.log("✅ 已创建 admin 用户 (密码: admin123)");
  } else {
    console.log("✅ admin 用户已存在");
  }

  // 2. Run migration from .migpt.js
  const migrated = await migrateFromFile(user.id);
  if (migrated) {
    console.log("✅ .migpt.js 配置已导入到数据库");

    // 3. Copy .mi.json for each account
    const accounts = await getAccounts(user.id);
    for (const account of accounts) {
      const miJsonPath = `.mi-${account.id}.json`;
      if (!existsSync(miJsonPath) && existsSync(".mi.json")) {
        copyFileSync(".mi.json", miJsonPath);
        console.log(`✅ .mi.json → ${miJsonPath}`);
      }
    }
  } else {
    console.log("ℹ️  .migpt.js 不存在或已迁移过，跳过");
  }

  console.log("\n🎉 迁移完成！请用 admin / admin123 登录 http://localhost:8408/login");
}

runWithDB(main);

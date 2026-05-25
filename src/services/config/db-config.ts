import { kPrisma } from "../db";
import type { XiaomiAccount, Speaker, AuthToken } from "@prisma/client";
import type { MiGPTConfig, MiGPTSpeakerConfig } from "../../index";

// ---- Helpers ----

function safeParse<T = any>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

// ---- Auth Token ----

export async function createAuthToken(webUserId: string): Promise<AuthToken> {
  const token = Buffer.from(
    `${webUserId}-${Date.now()}-${Math.random()}`
  ).toString("base64");
  return kPrisma.authToken.create({
    data: { token, webUserId },
  });
}

export async function validateAuthToken(
  token: string
): Promise<string | null> {
  const record = await kPrisma.authToken.findUnique({ where: { token } });
  if (!record) return null;
  return record.webUserId;
}

// ---- WebUser ----

export async function registerWebUser(
  username: string,
  passwordHash: string
) {
  const existing = await kPrisma.webUser.findUnique({
    where: { username },
  });
  if (existing) return null;
  return kPrisma.webUser.create({
    data: { username, passwordHash },
  });
}

export async function loginWebUser(username: string) {
  return kPrisma.webUser.findUnique({ where: { username } });
}

export async function deleteWebUser(webUserId: string): Promise<boolean> {
  const user = await kPrisma.webUser.findUnique({ where: { id: webUserId } });
  if (!user) return false;
  // 级联删除该用户的所有小米账号（及其音箱）
  const accounts = await kPrisma.xiaomiAccount.findMany({
    where: { webUserId },
    select: { id: true },
  });
  for (const a of accounts) {
    await kPrisma.speaker.deleteMany({ where: { accountId: a.id } });
  }
  await kPrisma.xiaomiAccount.deleteMany({ where: { webUserId } });
  await kPrisma.authToken.deleteMany({ where: { webUserId } });
  await kPrisma.webUser.delete({ where: { id: webUserId } });
  return true;
}

// ---- XiaomiAccount CRUD ----

export async function getAccounts(webUserId: string): Promise<XiaomiAccount[]> {
  return kPrisma.xiaomiAccount.findMany({
    where: { webUserId },
    include: { speakers: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function getAccount(
  id: string,
  webUserId: string
): Promise<XiaomiAccount | null> {
  return kPrisma.xiaomiAccount.findFirst({
    where: { id, webUserId },
    include: { speakers: true },
  });
}

export async function createAccount(data: {
  webUserId: string;
  userId: string;
  password?: string;
  passToken?: string;
  speakerDefaults?: object;
}): Promise<XiaomiAccount> {
  return kPrisma.xiaomiAccount.create({
    data: {
      userId: data.userId,
      password: data.password || "",
      passToken: data.passToken || "",
      speakerDefaults: JSON.stringify(data.speakerDefaults || {}),
      webUserId: data.webUserId,
    },
  });
}

export async function updateAccount(
  id: string,
  webUserId: string,
  data: {
    userId?: string;
    password?: string;
    passToken?: string;
    speakerDefaults?: object;
  }
): Promise<XiaomiAccount | null> {
  const account = await getAccount(id, webUserId);
  if (!account) return null;
  return kPrisma.xiaomiAccount.update({
    where: { id },
    data: {
      ...(data.userId !== undefined ? { userId: data.userId } : {}),
      ...(data.password !== undefined ? { password: data.password } : {}),
      ...(data.passToken !== undefined ? { passToken: data.passToken } : {}),
      ...(data.speakerDefaults !== undefined
        ? { speakerDefaults: JSON.stringify(data.speakerDefaults) }
        : {}),
    },
  });
}

export async function deleteAccount(
  id: string,
  webUserId: string
): Promise<boolean> {
  const account = await getAccount(id, webUserId);
  if (!account) return false;
  // delete speakers first
  await kPrisma.speaker.deleteMany({ where: { accountId: id } });
  await kPrisma.xiaomiAccount.delete({ where: { id } });
  return true;
}

// ---- Speaker CRUD ----

async function nextSeq(accountId: string): Promise<number> {
  const last = await kPrisma.speaker.findFirst({
    where: { accountId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return (last?.seq ?? 0) + 1;
}

export async function createSpeaker(
  accountId: string,
  xiaomiUserId: string,
  data: {
    did?: string;
    name?: string;
    model?: string;
    modelName?: string;
    config?: object;
  }
): Promise<Speaker> {
  const seq = await nextSeq(accountId);
  const id = `${xiaomiUserId}-${seq}`;
  const cfg = (data.config || {}) as Record<string, any>;
  // 如果有角色配置，立即创建 User 记录和 botIndex
  const botIndex = await initSpeakerBotIndex(id, cfg);
  return kPrisma.speaker.create({
    data: {
      id,
      accountId,
      did: data.did || "",
      name: data.name || "",
      model: data.model || "",
      modelName: data.modelName || "",
      config: JSON.stringify(cfg),
      botIndex: JSON.stringify(botIndex),
      seq,
    },
  });
}

async function initSpeakerBotIndex(
  _speakerId: string,
  cfg: Record<string, any>
): Promise<{ botId?: string; masterId?: string }> {
  const botName = cfg.botName as string | undefined;
  if (!botName) return {};
  const { UserCRUD } = await import("../db/user");
  const { RoomCRUD, getRoomID } = await import("../db/room");
  const bot = await UserCRUD.create({
    name: botName,
    profile: (cfg.botProfile as string) || "",
  });
  if (!bot) return {};
  const doCheck = [bot];
  let masterId: string | undefined;
  if (cfg.masterName) {
    const master = await UserCRUD.create({
      name: cfg.masterName as string,
      profile: (cfg.masterProfile as string) || "",
    });
    if (master) {
      masterId = master.id;
      doCheck.push(master);
    }
  }
  const roomId = getRoomID(doCheck);
  const roomName = (cfg.roomName as string) || `${bot.name}的私聊`;
  const roomDesc = (cfg.roomDescription as string) || roomName;
  await RoomCRUD.addOrUpdate({ id: roomId, name: roomName, description: roomDesc });
  return { botId: bot.id, ...(masterId ? { masterId } : {}) };
}

export async function updateSpeaker(
  id: string,
  data: {
    did?: string;
    name?: string;
    model?: string;
    modelName?: string;
    config?: object;
  }
): Promise<Speaker | null> {
  const speaker = await kPrisma.speaker.findUnique({ where: { id } });
  if (!speaker) return null;
  const cfg = (data.config || {}) as Record<string, any>;
  const updateData: any = {
    ...(data.did !== undefined ? { did: data.did } : {}),
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.model !== undefined ? { model: data.model } : {}),
    ...(data.modelName !== undefined ? { modelName: data.modelName } : {}),
    ...(data.config !== undefined
      ? { config: JSON.stringify(data.config) }
      : {}),
  };
  // 如果提供了角色配置，更新 User 记录和 botIndex
  if (data.config !== undefined && cfg.botName) {
    const botIndex = await initSpeakerBotIndex(id, cfg);
    updateData.botIndex = JSON.stringify(botIndex);
  }
  return kPrisma.speaker.update({ where: { id }, data: updateData });
}

export async function deleteSpeaker(id: string): Promise<boolean> {
  const speaker = await kPrisma.speaker.findUnique({ where: { id } });
  if (!speaker) return false;

  // 清理关联数据：botIndex 记录了 botId/masterId
  const index = safeParse<{ botId?: string; masterId?: string }>(speaker.botIndex, {});
  if (index.botId) {
    const roomId = index.masterId
      ? [index.botId, index.masterId].sort().join("_")
      : index.botId;
    const userIds = [index.botId, index.masterId].filter(Boolean) as string[];

    try {
      await kPrisma.$transaction([
        kPrisma.longTermMemory.deleteMany({ where: { roomId } }),
        kPrisma.shortTermMemory.deleteMany({ where: { roomId } }),
        kPrisma.memory.deleteMany({ where: { roomId } }),
        kPrisma.message.deleteMany({ where: { roomId } }),
        kPrisma.room.deleteMany({ where: { id: roomId } }),
        kPrisma.user.deleteMany({ where: { id: { in: userIds } } }),
      ]);
    } catch (e) {
      // 清理失败不影响音箱删除（例如 botIndex 指向的 User 已被手动删除）
      console.error("deleteSpeaker cleanup failed:", e);
    }
  }

  await kPrisma.speaker.delete({ where: { id } });
  return true;
}

export async function getSpeakers(accountId: string): Promise<Speaker[]> {
  return kPrisma.speaker.findMany({
    where: { accountId },
    orderBy: { seq: "asc" },
  });
}

// ---- Bot Index ----

export async function getBotIndex(
  speakerId: string
): Promise<{ botId: string; masterId?: string } | null> {
  const speaker = await kPrisma.speaker.findUnique({ where: { id: speakerId } });
  if (!speaker) return null;
  const index = safeParse<{ botId?: string; masterId?: string } | null>(speaker.botIndex, null);
  if (!index || !index.botId) return null;
  return { botId: index.botId, masterId: index.masterId };
}

export async function setBotIndex(
  speakerId: string,
  index: { botId: string; masterId?: string }
): Promise<void> {
  await kPrisma.speaker.update({
    where: { id: speakerId },
    data: { botIndex: JSON.stringify(index) },
  });
}

// ---- Build MiGPTConfig from DB ----

export async function buildMiGPTConfig(
  accountId: string
): Promise<MiGPTConfig | null> {
  const account = await kPrisma.xiaomiAccount.findUnique({
    where: { id: accountId },
    include: { speakers: { orderBy: { seq: "asc" } }, webUser: { select: { username: true } } },
  });
  if (!account) return null;
  const username = account.webUser?.username;

  const defaults = safeParse<any>(account.speakerDefaults, {});

  // Build top-level speaker (account-level shared config)
  const speaker: any = {};
  if (account.userId) speaker.userId = account.userId;
  if (account.password) speaker.password = account.password;
  if (account.passToken) speaker.passToken = account.passToken;
  // Copy keyword/tts defaults from speakerDefaults
  for (const key of [
    "callAIKeywords",
    "wakeUpKeywords",
    "exitKeywords",
    "switchSpeakerKeywords",
    "onEnterAI",
    "onExitAI",
    "onAIAsking",
    "onAIReplied",
    "onAIError",
  ]) {
    // Always set — absent keys become undefined, triggering AISpeaker's hardcoded defaults.
    // Empty arrays ([]) suppress the default since [] is not undefined.
    speaker[key] = defaults[key] ?? undefined;
  }

  // Build speakers array
  const speakers: MiGPTSpeakerConfig[] = account.speakers.map((sp) => {
    const cfg = safeParse<any>(sp.config, {});
    return {
      id: sp.id,
      did: sp.did || undefined,
      name: sp.name || undefined,
      model: sp.model || undefined,
      modelName: sp.modelName || undefined,
      ttsCommand: cfg.ttsCommand || [5, 1],
      wakeUpCommand: cfg.wakeUpCommand || [5, 3],
      tts: cfg.tts || "xiaoai",
      streamResponse: cfg.streamResponse ?? false,
      bot: cfg.botName
        ? { name: cfg.botName, profile: cfg.botProfile || "" }
        : undefined,
      master: cfg.masterName
        ? { name: cfg.masterName, profile: cfg.masterProfile || "" }
        : undefined,
      room: cfg.roomName
        ? { name: cfg.roomName, description: cfg.roomDescription || "" }
        : undefined,
      systemTemplate: cfg.systemTemplate || undefined,
    } as unknown as MiGPTSpeakerConfig;
  });

  return {
    username,
    speaker,
    speakers: speakers.length > 0 ? speakers : undefined,
    bot: defaults.botName
      ? ({ name: defaults.botName, profile: defaults.botProfile || "" } as any)
      : undefined,
    master: defaults.masterName
      ? ({ name: defaults.masterName, profile: defaults.masterProfile || "" } as any)
      : undefined,
    room: defaults.roomName
      ? ({ name: defaults.roomName, description: defaults.roomDescription || "" } as any)
      : undefined,
    systemTemplate: defaults.systemTemplate || undefined,
  };
}

// ---- Migration from .migpt.js ----

export async function migrateFromFile(webUserId: string): Promise<boolean> {
  const { existsSync, renameSync } = await import("fs");
  const path = await import("path");

  const configPath = path.join(process.cwd(), ".migpt.js");

  if (!existsSync(configPath)) return false;

  try {
    const config = (await import(`${configPath}?t=${Date.now()}`)).default;
    const sp = config.speaker || {};

    // Create account from config
    const account = await createAccount({
      webUserId,
      userId: sp.userId || "",
      password: sp.password || "",
      passToken: sp.passToken || "",
      speakerDefaults: {
        callAIKeywords: sp.callAIKeywords || [],
        wakeUpKeywords: sp.wakeUpKeywords || [],
        exitKeywords: sp.exitKeywords || [],
        switchSpeakerKeywords: sp.switchSpeakerKeywords || [],
        onEnterAI: sp.onEnterAI || [],
        onExitAI: sp.onExitAI || [],
        onAIAsking: sp.onAIAsking || [],
        onAIReplied: sp.onAIReplied || [],
        onAIError: sp.onAIError || [],
        botName: config.bot?.name || "",
        botProfile: config.bot?.profile || "",
        masterName: config.master?.name || "",
        masterProfile: config.master?.profile || "",
        roomName: config.room?.name || "",
        roomDescription: config.room?.description || "",
        systemTemplate: config.systemTemplate || "",
      },
    });

    // Create speakers
    const speakerList = config.speakers || [];
    for (const s of speakerList) {
      await createSpeaker(account.id, account.userId, {
        did: s.did || sp.did || "",
        name: s.name || "",
        model: s.model || "",
        modelName: s.modelName || "",
        config: {
          ttsCommand: s.ttsCommand || [5, 1],
          wakeUpCommand: s.wakeUpCommand || [5, 3],
          tts: s.tts || "xiaoai",
          streamResponse: s.streamResponse ?? false,
          botName: s.bot?.name || config.bot?.name || "",
          botProfile: s.bot?.profile || config.bot?.profile || "",
          masterName: s.master?.name || config.master?.name || "",
          masterProfile: s.master?.profile || config.master?.profile || "",
          roomName: s.room?.name || "",
          roomDescription: s.room?.description || "",
          systemTemplate: s.systemTemplate || config.systemTemplate || "",
        },
      });
    }

    // Rename old config file
    renameSync(configPath, configPath + ".bak");
    return true;
  } catch (e) {
    console.error("Migration from .migpt.js failed:", e);
    return false;
  }
}

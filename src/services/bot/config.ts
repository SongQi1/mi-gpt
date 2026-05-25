import { Room, User } from "@prisma/client";
import { removeEmpty } from "../../utils/base";
import { readJSON, writeJSON } from "../../utils/io";
import { DeepPartial } from "../../utils/type";
import { RoomCRUD, getRoomID } from "../db/room";
import { UserCRUD } from "../db/user";
import { Logger } from "../../utils/log";
import { getBotIndex as getDBBotIndex, setBotIndex as setDBBotIndex } from "../config/db-config";

const kDefaultBot = {
  name: "傻妞",
  profile: `
性别：女
性格：乖巧可爱
爱好：喜欢搞怪，爱吃醋。
  `.trim(),
};

interface IBotIndex {
  botId: string;
  masterId?: string;
}

export interface IBotConfig {
  bot: User;
  master?: User;
  room: Room;
}

export class BotConfigStore {
  private _logger = Logger.create({ tag: "BotConfig" });
  private botIndex?: IBotIndex;
  private _initialConfig?: DeepPartial<IBotConfig>;

  constructor(
    private _indexPath = ".bot.json",
    private _useDB = false,
    initialConfig?: DeepPartial<IBotConfig>
  ) {
    this._initialConfig = initialConfig;
  }

  private async _getIndex(): Promise<IBotIndex | undefined> {
    if (!this.botIndex) {
      if (this._useDB) {
        this.botIndex = (await getDBBotIndex(this._indexPath)) ?? undefined;
      } else {
        this.botIndex = await readJSON(this._indexPath);
      }
    }
    return this.botIndex;
  }

  private async _saveIndex(index: IBotIndex): Promise<void> {
    this.botIndex = index;
    if (this._useDB) {
      await setDBBotIndex(this._indexPath, index);
    } else {
      await writeJSON(this._indexPath, index);
    }
  }

  async get(): Promise<IBotConfig | undefined> {
    const index = await this._getIndex();
    if (!index) {
      return this._initConfig();
    }
    const currentIndex = this.botIndex!;
    const bot = await UserCRUD.get(currentIndex.botId);
    if (!bot) {
      this._logger.log("bot missing, recreating...");
      return this._initConfig();
    }
    const master = currentIndex.masterId
      ? (await UserCRUD.get(currentIndex.masterId)) ?? undefined
      : undefined;
    const roomId = master ? getRoomID([bot, master]) : getRoomID([bot]);
    const room = await RoomCRUD.get(roomId);
    if (!room) {
      this._logger.log("room missing, recreating...");
      if (master) {
        return this._initConfig();
      }
      return this._initConfig();
    }
    return { bot, master, room };
  }

  private async _initConfig(): Promise<IBotConfig | undefined> {
    const defaultBot = this._initialConfig?.bot?.name
      ? { name: this._initialConfig.bot.name!, profile: this._initialConfig.bot.profile || "" }
      : kDefaultBot;
    const bot = await UserCRUD.create(defaultBot);
    if (!bot) {
      this._logger.error("create bot failed");
      return undefined;
    }
    const roomName = this._initialConfig?.room?.name || `${bot.name}的私聊`;
    const roomDesc = this._initialConfig?.room?.description || roomName;
    const doCheck = [bot];
    let master: User | undefined;
    if (this._initialConfig?.master?.name) {
      master = (await UserCRUD.create({
        name: this._initialConfig.master.name!,
        profile: this._initialConfig.master.profile || "",
      })) ?? undefined;
      if (master) doCheck.push(master);
    }
    const roomId = getRoomID(doCheck);
    const room = await RoomCRUD.addOrUpdate({
      id: roomId,
      name: roomName,
      description: roomDesc,
    });
    if (!room) {
      this._logger.error("create room failed");
      return undefined;
    }
    const newIndex: IBotIndex = { botId: bot.id };
    if (master) newIndex.masterId = master.id;
    await this._saveIndex(newIndex);
    return { bot, master, room };
  }

  async update(
    config: DeepPartial<IBotConfig>
  ): Promise<IBotConfig | undefined> {
    let currentConfig = await this.get();
    if (!currentConfig) {
      return undefined;
    }
    const hasMasterConfig = !!(config.master && (config.master.name || config.master.profile));

    if (config.bot) {
      currentConfig.bot = {
        ...currentConfig.bot,
        ...removeEmpty(config.bot),
      } as unknown as User;
    }
    if (config.room) {
      currentConfig.room = {
        ...currentConfig.room,
        ...removeEmpty(config.room),
      } as unknown as Room;
    }
    if (hasMasterConfig) {
      const existingMaster = currentConfig.master || { id: "", name: "", profile: "", createdAt: new Date(), updatedAt: new Date() };
      currentConfig.master = {
        ...existingMaster,
        ...removeEmpty(config.master),
      } as unknown as User;
    }

    let { bot, master, room } = currentConfig;
    const newDefaultRoomName = master
      ? `${master.name}和${bot.name}的私聊`
      : `${bot.name}的私聊`;
    if (room.name.endsWith("的私聊")) {
      room.name = config.room?.name ?? newDefaultRoomName;
    }
    if (room.description.endsWith("的私聊")) {
      room.description = config.room?.description ?? newDefaultRoomName;
    }
    bot = (await UserCRUD.addOrUpdate(bot))!;
    if (master && hasMasterConfig) {
      master = (await UserCRUD.addOrUpdate(master))!;
      const newRoomId = getRoomID([bot, master]);
      room.id = newRoomId;
      room = (await RoomCRUD.addOrUpdate(room))!;
      await this._saveIndex({ botId: bot.id, masterId: master.id });
    } else {
      room = (await RoomCRUD.addOrUpdate(room))!;
    }
    return { bot, master, room };
  }
}

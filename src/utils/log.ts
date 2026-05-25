import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { toSet } from "./base";
import { isString } from "./is";
import { formatDateTime } from "./string";

export interface LogEntry {
  timestamp: string;
  level: "log" | "debug" | "error" | "success";
  tag: string;
  message: string;
  username?: string;
}

const kMaxLogEntries = 1000;

class _LoggerManager {
  disable = false;
  _excludes: string[] = [];
  private _buffer: LogEntry[] = [];
  private _cursor = 0;
  private _logDir = join(process.cwd(), "logs");

  excludes(tags: string[]) {
    this._excludes = toSet(this._excludes.concat(tags));
  }

  includes(tags: string[]) {
    for (const tag of tags) {
      const idx = this._excludes.indexOf(tag);
      if (idx > -1) {
        this._excludes.splice(idx, 1);
      }
    }
  }

  /** 获取最近的日志（内存 + 当天文件），按时间正序（旧→新） */
  getLogs(filter?: { tag?: string; username?: string; limit?: number }): LogEntry[] {
    // 1. 收集内存缓冲区的日志
    const bufferEntries = this._buffer.filter((e) => e.message !== "");
    // 用 timestamp+tag+message 作为去重 key
    const seen = new Set(bufferEntries.map((e) => `${e.timestamp}|${e.tag}|${e.message}`));

    // 2. 从当天日志文件读取（服务重启后内存丢失，但文件还在）
    const fileEntries: LogEntry[] = [];
    const todayPath = this._getDailyLogPath();
    if (existsSync(todayPath)) {
      try {
        const content = readFileSync(todayPath, "utf8");
        if (content) {
          for (const line of content.trim().split("\n")) {
            if (!line) continue;
            try {
              const entry: LogEntry = JSON.parse(line);
              const key = `${entry.timestamp}|${entry.tag}|${entry.message}`;
              if (!seen.has(key)) {
                seen.add(key);
                fileEntries.push(entry);
              }
            } catch { /* skip malformed */ }
          }
        }
      } catch { /* skip unreadable */ }
    }

    // 3. 合并、排序、过滤
    let entries = [...bufferEntries, ...fileEntries];
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (filter?.username) {
      entries = entries.filter((e) => e.username === filter.username);
    }
    if (filter?.tag) {
      entries = entries.filter((e) => e.tag.includes(filter.tag!));
    }
    const limit = filter?.limit ?? 200;
    return entries.slice(-limit);
  }

  private _getDailyLogPath(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return join(this._logDir, `${y}-${m}-${d}.log`);
  }

  private _appendToFile(entry: LogEntry): void {
    try {
      if (!existsSync(this._logDir)) {
        mkdirSync(this._logDir, { recursive: true });
      }
      appendFileSync(this._getDailyLogPath(), JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // 文件写入失败不影响应用运行
    }
  }

  /** 查询历史日志（从日志文件读取），日期格式 YYYY-MM-DD */
  getHistoryLogs(filter?: {
    from: string;
    to: string;
    tag?: string;
    username?: string;
    level?: string;
    limit?: number;
  }): LogEntry[] {
    if (!filter?.from || !filter?.to) return [];
    const results: LogEntry[] = [];
    const start = new Date(filter.from + "T00:00:00");
    const end = new Date(filter.to + "T23:59:59");
    const limit = filter.limit ?? 1000;

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const filePath = join(this._logDir, `${y}-${m}-${day}.log`);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, "utf8");
        if (!content) continue;
        for (const line of content.trim().split("\n")) {
          if (!line) continue;
          try {
            const entry: LogEntry = JSON.parse(line);
            if (filter.username && entry.username !== filter.username) continue;
            if (filter.tag && !entry.tag.includes(filter.tag)) continue;
            if (filter.level && entry.level !== filter.level) continue;
            results.push(entry);
          } catch { /* skip malformed lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    // 按时间正序（旧→新）
    results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return results.slice(0, limit);
  }

  private _append(entry: LogEntry, username?: string) {
    if (username) entry.username = username;
    this._buffer[this._cursor % kMaxLogEntries] = entry;
    this._cursor++;
    this._appendToFile(entry);
  }

  private _getLogs(tag: string, ...args: any[]) {
    if (this.disable || this._excludes.includes(tag)) {
      return [];
    }
    const date = formatDateTime(new Date());
    let prefix = `${date} ${tag} `;
    if (args.length < 1) {
      args = [undefined];
    }
    if (isString(args[0])) {
      prefix += args[0];
      args = args.slice(1);
    }
    return [prefix, ...args];
  }

  private _fmtMsg(args: any[]): string {
    return args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "object") {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a ?? "");
      })
      .join(" ");
  }

  log(tag: string, args: any[] = [], username?: string) {
    const logs = this._getLogs(tag, ...args);
    if (logs.length > 0) {
      console.log(...logs);
    }
    this._append({ timestamp: formatDateTime(new Date()), level: "log", tag, message: this._fmtMsg(args) }, username);
  }

  debug(tag: string, args: any[], username?: string) {
    const logs = this._getLogs(tag + " 🐛", ...args);
    if (logs.length > 0) {
      console.log(...logs);
    }
    this._append({ timestamp: formatDateTime(new Date()), level: "debug", tag, message: this._fmtMsg(args) }, username);
  }

  success(tag: string, args: any[], username?: string) {
    const logs = this._getLogs(tag + " ✅", ...args);
    if (logs.length > 0) {
      console.log(...logs);
    }
    this._append({ timestamp: formatDateTime(new Date()), level: "success", tag, message: this._fmtMsg(args) }, username);
  }

  error(tag: string, args: any[], username?: string) {
    const logs = this._getLogs(tag + " ❌", ...args);
    if (logs.length > 0) {
      console.error(...logs);
    }
    this._append({ timestamp: formatDateTime(new Date()), level: "error", tag, message: this._fmtMsg(args) }, username);
  }

  assert(tag: string, value: any, args: any[], username?: string) {
    const logs = this._getLogs(tag + " ❌", ...args);
    if (!value) {
      console.error(...logs);
      this._append({ timestamp: formatDateTime(new Date()), level: "error", tag, message: this._fmtMsg(args) }, username);
      throw Error("❌ Assertion failed");
    }
  }
}

export const LoggerManager = new _LoggerManager();

export interface LoggerConfig {
  tag?: string;
  username?: string;
  disable?: boolean;
}
class _Logger {
  tag: string;
  username?: string;
  disable: boolean;
  constructor(config?: LoggerConfig) {
    const { tag = "default", username, disable = false } = config ?? {};
    this.tag = tag;
    this.username = username;
    this.disable = disable;
  }

  create(config?: LoggerConfig) {
    return new _Logger(config);
  }

  log(...args: any[]) {
    if (!this.disable) {
      LoggerManager.log(this.tag, args, this.username);
    }
  }

  debug(...args: any[]) {
    if (!this.disable) {
      LoggerManager.debug(this.tag, args, this.username);
    }
  }

  success(...args: any[]) {
    if (!this.disable) {
      LoggerManager.success(this.tag, args, this.username);
    }
  }

  error(...args: any[]) {
    if (!this.disable) {
      LoggerManager.error(this.tag, args, this.username);
    }
  }

  assert(value: any, ...args: any[]) {
    LoggerManager.assert(this.tag, value, args, this.username);
  }
}

export const Logger = new _Logger();

// 配置归一化。值来自 cordis.patch.yml 的 config 行，缺的用这里兜底。
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = {
  port: 17322,
  host: '127.0.0.1',
  // 不给默认值：写死的共享密钥等于给本机任何进程发通行证。
  // 空值时下面的鉴权会一律拒绝，用户必须自己填一个（与 Roost 的 trpg-forwarder 一致）。
  token: '',
  agentPreset: 'trpg-keeper',
  roostSendUrl: 'http://127.0.0.1:8080/api/plugins/trpg-forwarder/r/send',
  batchWindowMs: 6000,
  maxBatch: 6,
  turnBudget: 8,
  turnTimeoutMs: 300000,
  dbPath: '',
  defaultModule: 'mist-harbor',
  workspaceDir: '',
  roostAccessKey: '',
  /**
   * 指令提示文本（/help 或 /帮助 的内容）。
   * 留空用内置那份；管理页可以改，改完立即生效。
   */
  helpText: '',
};

export function readConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  /** 数据目录。允许由配置项覆盖 —— 主要是为了测试能整目录隔离 */
  const dataDir = String(c.dataDir || '').trim() || join(homedir(), '.dsh', 'dsh-trpg');
  return {
    port: num(c.port, DEFAULTS.port),
    host: String(c.host || DEFAULTS.host),
    token: String(c.token ?? DEFAULTS.token),
    agentPreset: String(c.agentPreset || DEFAULTS.agentPreset),
    roostSendUrl: String(c.roostSendUrl || DEFAULTS.roostSendUrl).replace(/\/+$/, ''),
    batchWindowMs: num(c.batchWindowMs, DEFAULTS.batchWindowMs),
    maxBatch: num(c.maxBatch, DEFAULTS.maxBatch),
    turnBudget: num(c.turnBudget, DEFAULTS.turnBudget),
    turnTimeoutMs: num(c.turnTimeoutMs, DEFAULTS.turnTimeoutMs),
    dbPath: String(c.dbPath || '').trim() || join(dataDir, 'trpg.sqlite'),
    dataDir,
    /**
     * F2：以前只读 `defaultModule`，设置页那个 `moduleId` 下拉是装饰品 ——
     * 改完不生效，只有手写 config.json 才有用。两个名字都收，moduleId 优先。
     */
    moduleId: String(c.moduleId || c.defaultModule || DEFAULTS.defaultModule),
    defaultModule: String(c.moduleId || c.defaultModule || DEFAULTS.defaultModule),
    workspaceDir: String(c.workspaceDir || '').trim() || join(dataDir, 'workspace'),
    roostAccessKey: String(c.roostAccessKey || ''),
    helpText: String(c.helpText || ''),
  };
}

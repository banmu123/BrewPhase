/**
 * 活跃连接的进程内路由表（协议 §12.2 第一版）。
 *
 * ## 为什么接口是 Promise 而实现是同步的
 *
 * Phase 1.4 会换成 Redis（`mcp:conn:{user_id}:{device_id}` + TTL）。现在把
 * 签名定成异步，是为了那一天**不需要改调用方**——协议不变，实现替换。
 * 而实现里刻意**不 await**：`bind` 必须是原子的，中间有任何挂起点，
 * 「先 bind 新再断旧」这条顺序保证就漏了。
 *
 * ## 单用户单连接
 *
 * 第一版**每个用户只允许一个活跃连接**（协议 §4.6）。所以键是 `userId`：
 * 同一用户的第二台设备上线时，第一台必须被顶替（close 4006）。
 * `deviceId` 仍然记录在表项里，供 `lookup(userId, deviceId)` 核对——
 * 顶替之后，旧设备 id 的查询必须返回 `null`，而不是把连接「借」给它。
 *
 * ## `unbind` 必须带 connectionId
 *
 * 顶替序列是「bind 新的 → 断旧的 → 旧连接的 close 回调 unbind」。
 * 如果 `unbind` 只按 `(userId, deviceId)` 删，那个迟到的回调会把**新**连接
 * 从表里删掉——而新连接还活着，于是后续请求全部 `DEVICE_OFFLINE`。
 * 这不是理论问题：Close 事件到达顺序没有任何保证。
 */

export interface ConnectionInfo {
  userId: string;
  deviceId: string;
  connectionId: string;
  instanceId: string;
  /** 建立时刻（monotonic 毫秒），用于诊断与稳定期判定。 */
  boundAtMono: number;
  /** 最后一次**有效 pong** 的时刻（monotonic）。心跳超时判据用它。 */
  lastPongAtMono: number | null;
  /** Desktop 自报的服务能力（`hello.serviceable` / `status` 帧）。提示，不是授权。 */
  serviceable: boolean;
}

/** `bind` 的返回值：被顶替的旧连接（没有则为 null）。 */
export interface BindResult {
  displaced: ConnectionInfo | null;
}

export interface ConnectionRegistry {
  bind(entry: Omit<ConnectionInfo, "boundAtMono" | "lastPongAtMono">, nowMono: number): Promise<BindResult>;
  /** 只有 `connectionId` 与表内一致才删。返回是否真的删了。 */
  unbind(userId: string, deviceId: string, connectionId: string): Promise<boolean>;
  /** 按 `(userId, deviceId)` 精确查；设备不匹配返回 null（顶替后的旧设备就是这种）。 */
  lookup(userId: string, deviceId: string): Promise<ConnectionInfo | null>;
  lookupByUser(userId: string): Promise<ConnectionInfo | null>;
  /**
   * 按 deviceId 反查。
   *
   * 用于「设备被暂停/撤销后清连接」：那条路径手里只有设备行（`id` 是全表
   * 唯一的 uuid），没有用户的 session 上下文。让路由层为了一个 userId 再
   * 查一次库，既多一次 IO，也多一个「查错行」的机会。
   */
  lookupByDevice(deviceId: string): Promise<ConnectionInfo | null>;
  /** 记录一次**有效 pong**（心跳续约）。`connectionId` 不匹配视为噪音，返回 false。 */
  touch(userId: string, deviceId: string, connectionId: string, nowMono: number): Promise<boolean>;
  setServiceable(userId: string, deviceId: string, connectionId: string, serviceable: boolean): Promise<boolean>;
  listByUser(userId: string): Promise<ConnectionInfo[]>;
  count(): number;
  clear(): void;
}

export function createMemoryConnectionRegistry(): ConnectionRegistry {
  const byUser = new Map<string, ConnectionInfo>();

  return {
    async bind(entry, nowMono) {
      const previous = byUser.get(entry.userId) ?? null;
      byUser.set(entry.userId, {
        ...entry,
        boundAtMono: nowMono,
        lastPongAtMono: null,
      });
      // 同一连接重复 bind（理论上不会发生）不算顶替。
      const displaced = previous && previous.connectionId !== entry.connectionId ? previous : null;
      return { displaced };
    },

    async unbind(userId, deviceId, connectionId) {
      const current = byUser.get(userId);
      if (!current) return false;
      // 两个条件都要比：迟到回调既能带来旧 connectionId，也能带来旧 deviceId。
      if (current.connectionId !== connectionId) return false;
      if (current.deviceId !== deviceId) return false;
      byUser.delete(userId);
      return true;
    },

    async lookup(userId, deviceId) {
      const current = byUser.get(userId);
      if (!current) return null;
      // 设备不匹配 = 这台设备已被另一台顶替。返回 null 而不是 current：
      // 否则旧设备的请求会被路由到新设备的连接上。
      return current.deviceId === deviceId ? current : null;
    },

    async lookupByUser(userId) {
      return byUser.get(userId) ?? null;
    },

    async lookupByDevice(deviceId) {
      // 表最多几十条（单实例 + 每用户一条），线性扫描比维护第二份索引更安全：
      // 第二份索引与主表的一致性会成为新的 bug 来源。
      for (const info of byUser.values()) {
        if (info.deviceId === deviceId) return info;
      }
      return null;
    },

    async touch(userId, deviceId, connectionId, nowMono) {
      const current = byUser.get(userId);
      if (!current || current.connectionId !== connectionId || current.deviceId !== deviceId) return false;
      current.lastPongAtMono = nowMono;
      return true;
    },

    async setServiceable(userId, deviceId, connectionId, serviceable) {
      const current = byUser.get(userId);
      if (!current || current.connectionId !== connectionId || current.deviceId !== deviceId) return false;
      current.serviceable = serviceable;
      return true;
    },

    async listByUser(userId) {
      const current = byUser.get(userId);
      return current ? [current] : [];
    },

    count() {
      return byUser.size;
    },

    clear() {
      byUser.clear();
    },
  };
}

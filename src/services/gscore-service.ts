
import WebSocket from 'ws';
import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import { pluginState } from '../core/state';

/**
 * GsCore Message 结构（早柚核心消息单元）
 */
interface GsCoreMessage {
  type: string | null;
  data: unknown;
}

/**
 * GsCore MessageSend 结构（早柚核心发送的消息）
 */
interface GsCoreMessageSend {
  bot_id: string;
  bot_self_id: string;
  msg_id: string;
  target_type: string | null;
  target_id: string | null;
  content: GsCoreMessage[] | null;
  echo?: string | null;
}

type GsCoreContent = Array<{ type: string; data: unknown }>;

type RecallMessageId = string | string[] | number | number[] | null;

const NODE_MARK = '[合并转发]';
const NODE_MAX_DEPTH = 3;

export class GScoreService {
  private static instance: GScoreService;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private isManualRetry: boolean = false;
  private isTimeoutTerminated: boolean = false;
  private readonly CONNECTION_TIMEOUT = 10000;

  private constructor() { }

  public static getInstance(): GScoreService {
    if (!GScoreService.instance) {
      GScoreService.instance = new GScoreService();
    }
    return GScoreService.instance;
  }

  public getStatus(): 'connected' | 'connecting' | 'disconnected' {
    if (this.ws?.readyState === WebSocket.OPEN) return 'connected';
    if (this.isConnecting || this.ws?.readyState === WebSocket.CONNECTING || this.reconnectTimer) return 'connecting';
    return 'disconnected';
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * 手动重连命令处理
   */
  public async manualReconnect(): Promise<string> {
    if (this.isManualRetry) {
      return '⚠️ 手动重连正在进行中，请勿重复触发。';
    }

    const maxAttempts = pluginState.config.maxReconnectAttempts ?? 10;
    if (maxAttempts === 0) {
      return '当前已开启无限重连模式，连接器会自动尝试连接，您无需执行此命令。';
    }

    const status = this.getStatus();
    if (status === 'connected') {
      return '✅ 当前 Bot 已连接。';
    }
    if (status === 'connecting') {
      return '🔄 正在重连中，请稍后查看状态。';
    }

    this.disconnect(true);
    this.isManualRetry = true;
    pluginState.logger.info('[GScore] 触发手动重连命令');
    this.connect();

    const result = await new Promise<string>((resolve) => {
      const timer = setInterval(() => {
        if (this.getStatus() === 'connected') {
          clearInterval(timer);
          this.isManualRetry = false;
          resolve('✅ 当前 Bot 已连接。');
          return;
        }
        if (!this.isManualRetry) {
          clearInterval(timer);
          resolve('❌ 连接失败，手动重连次数已达上限，请检查配置或手动重试。');
        }
      }, 500);
    });

    return result;
  }


  public connect() {
    if (!pluginState.config.gscoreEnable) {
      this.disconnect();
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      pluginState.logger.debug('[GScore] 连接已存在或正在连接中，跳过重复连接');
      return;
    }

    // 如果存在定时器，先清除
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    this.isConnecting = true;
    let url = pluginState.config.gscoreUrl || 'ws://localhost:8765';

    // 确保 url 不以 / 结尾
    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }

    // 默认使用 napcat-qq号 作为 bot_id 以兼容多 bot；
    // 开启“禁用多 bot 功能”后，固定使用 napcat 作为 bot_id。
    const botId = pluginState.config.disableMultiBot ? 'napcat' : `napcat-${pluginState.selfId || 'unknown'}`;
    // 如果 url 不包含 /ws/，则拼接 /ws/{botId}
    if (!url.includes('/ws/')) {
      url = `${url}/ws/${botId}`;
    }

    const token = pluginState.config.gscoreToken || '';

    // 如果 url 不包含 token 且 token 存在，则拼接到 url query
    const wsUrl = new URL(url);
    if (token && !wsUrl.searchParams.has('token')) {
      wsUrl.searchParams.append('token', token);
    }

    pluginState.logger.info(`[GScore] 正在连接...`);

    try {
      this.ws = new WebSocket(wsUrl.toString());

      this.connectionTimeout = setTimeout(() => {
        if (this.isConnecting && this.ws && this.ws.readyState !== WebSocket.OPEN) {
          pluginState.logger.warn('[GScore] 连接超时，正在终止...');
          this.isTimeoutTerminated = true;
          this.isConnecting = false;
          this.ws.terminate();
        }
      }, this.CONNECTION_TIMEOUT);

      this.ws.on('open', () => {
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        pluginState.logger.info('[GScore] 连接成功！');
        this.isConnecting = false;
        this.isTimeoutTerminated = false;
        this.reconnectAttempts = 0;
        this.isManualRetry = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      });

      this.ws.on('message', (data) => {
        try {
          // GsCore 发回的是 MessageSend 的二进制 JSON
          const raw = typeof data === 'string' ? data : data.toString('utf-8');
          const msgSend = JSON.parse(raw) as GsCoreMessageSend;

          pluginState.logger.debug(`[GScore] 收到消息: target_type=${msgSend.target_type}, target_id=${msgSend.target_id}`);

          // 处理 GsCore 发回的消息
          this.handleGsCoreMessage(msgSend);
        } catch (err) {
          pluginState.logger.error('[GScore] 解析收到的消息失败:', err);
        }
      });

      this.ws.on('error', (err) => {
        if (!this.isTimeoutTerminated) {
          const errorMsg = err.message || '连接失败（可能是目标地址不可达或被拒绝）';
          const errorCode = (err as any).code || '';
          if (errorCode) {
            pluginState.logger.error(`[GScore] 连接错误 [${errorCode}]: ${errorMsg}`);
          } else {
            pluginState.logger.error(`[GScore] 连接错误: ${errorMsg}`);
          }
        }
        if (this.isConnecting) {
          this.isConnecting = false;
        }
      });

      this.ws.on('close', (code, reason) => {
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        this.isConnecting = false;
        this.ws = null;
        if (!this.isTimeoutTerminated) {
          const reasonStr = reason.toString() || '';
          if (code === 1006) {
            pluginState.logger.warn(`[GScore] 连接异常关闭 (1006): ${reasonStr || '目标服务器无响应或连接被拒绝，请检查 gscoreUrl 是否正确'}`);
          } else {
            pluginState.logger.warn(`[GScore] 连接关闭: ${code} ${reasonStr}`);
          }
        }
        this.isTimeoutTerminated = false;
        setImmediate(() => this.scheduleReconnect());
      });

    } catch (error) {
      pluginState.logger.error('[GScore] 创建连接失败:', error);
      this.isConnecting = false;
      setImmediate(() => this.scheduleReconnect());
    }
  }

  public disconnect(resetCounter: boolean = true) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
    this.isTimeoutTerminated = false;
    if (resetCounter) {
      this.reconnectAttempts = 0;
      this.isManualRetry = false;
    }
  }

  private scheduleReconnect() {
    if (!pluginState.config.gscoreEnable) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const maxAttempts = this.isManualRetry ? 3 : (pluginState.config.maxReconnectAttempts ?? 10);

    // maxAttempts 为 0 时表示无限重试
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      if (this.isManualRetry) {
        pluginState.logger.error(`[GScore] 手动重连次数已达上限（${maxAttempts})，停止重连。请检查配置或手动重试。`);
      } else {
        pluginState.logger.error(`[GScore] 自动重连次数已达上限（${maxAttempts})，停止重连。请检查配置或手动重试。`);
      }
      this.isManualRetry = false;
      return;
    }

    // 使用配置的重连间隔，如果没配置则默认 5000ms
    const interval = pluginState.config.reconnectInterval ?? 5000;

    const attemptInfo = maxAttempts > 0 ? `${this.reconnectAttempts + 1}/${maxAttempts}` : `${this.reconnectAttempts + 1}/∞`;
    pluginState.logger.info(`[GScore] ${interval / 1000} 秒后尝试重连 (${attemptInfo})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      pluginState.logger.info(`[GScore] 开始第 ${this.reconnectAttempts} 次重连尝试...`);
      this.connect();
    }, interval);
  }

  private getBotId(): string {
    return 'onebot';
  }

  private getBotSelfId(fallback?: unknown): string {
    return String(pluginState.selfId || fallback || '');
  }

  private sendMessageReceive(messageReceive: Record<string, unknown>) {
    if (this.getStatus() !== 'connected') return;

    const payload = JSON.stringify(messageReceive);
    // GsCore 使用 receive_bytes()，需要发送二进制帧
    this.ws?.send(Buffer.from(payload));
  }

  /**
   * 将 OB11 消息转发到 GsCore
   * 按照早柚协议文档，将 OB11 消息转换为 MessageReceive 格式
   */
  public async forwardMessage(event: OB11Message) {
    if (this.getStatus() !== 'connected') return;

    // 仅转发群消息和私聊消息
    if (event.message_type !== 'group' && event.message_type !== 'private') return;

    try {
      // 将 OB11 message 段转换为 GsCore 的 Message[] (content)
      const content = await this.convertOB11ToGsCoreContent(event);
      const quotedContext: GsCoreContent = [];

      let replySeg;
      if (Array.isArray(event.message)) {
        replySeg = event.message.find((seg) => seg.type === 'reply');
      }

      if (replySeg) {
        const replyId = this.stringifyId((replySeg.data as any)?.id);
        if (replyId) {
          quotedContext.push({ type: 'reply_id', data: replyId });

          try {
            const ctx = pluginState.ctx;
            const replyMsg = await ctx.actions.call('get_msg', { message_id: replyId }, ctx.adapterName, ctx.pluginManager.config) as OB11Message;

            pluginState.logger.debug(`[GScore] 获取到的引用消息: ${JSON.stringify(replyMsg)}`);

            const replySegments = Array.isArray(replyMsg?.message) ? replyMsg.message : [];
            let replyText = this.stripForwardCqCode(
              this.extractPlainText(replySegments, replyMsg?.raw_message)
            );
            const quotedImages = this.extractImages(replySegments);
            const nodeItems = await this.extractForwardNodes(replySegments);

            if (nodeItems.length > 0) {
              replyText = this.formatNodePreview(nodeItems);
            }

            quotedContext.push({ type: 'reply', data: replyText });
            quotedContext.push(...quotedImages.map((image) => ({ type: 'image', data: image })));

            if (nodeItems.length > 0) {
              quotedContext.push({ type: 'node', data: nodeItems });
              for (const image of this.extractNodeImages(nodeItems)) {
                quotedContext.push({ type: 'image', data: image });
              }
            }
          } catch (err) {
            pluginState.logger.warn(`[GScore] 获取引用消息失败: ${err}`);
            quotedContext.push({ type: 'reply', data: '' });
          }
        }
      }

      content.push(...quotedContext);

      // 确定 user_type
      const userType = event.message_type === 'group' ? 'group' : 'direct';

      // 确定 user_pm（用户权限）
      let userPm = 6; // 默认普通用户
      const sender = event.sender as Record<string, unknown> | undefined;
      if (sender) {
        if (sender.role === 'owner') userPm = 2;
        else if (sender.role === 'admin') userPm = 3;
      }

      // 构造 GsCore MessageReceive 结构
      // 所有 ID 字段必须为 string 类型
      const messageReceive = {
        bot_id: this.getBotId(),
        bot_self_id: this.getBotSelfId(event.self_id),
        msg_id: String(event.message_id || ''),
        user_type: userType,
        group_id: event.group_id ? String(event.group_id) : null,
        user_id: String(event.user_id),
        sender: sender ? {
          ...sender,
          user_id: sender.user_id ? String(sender.user_id) : String(event.user_id),
          nickname: sender.nickname || sender.card || '',
          avatar: `https://q1.qlogo.cn/g?b=qq&nk=${sender.user_id || event.user_id}&s=640`
        } : {
          user_id: String(event.user_id),
          nickname: '',
          avatar: `https://q1.qlogo.cn/g?b=qq&nk=${event.user_id}&s=640`
        },
        user_pm: userPm,
        content: content,
      };

      this.sendMessageReceive(messageReceive);
      pluginState.logger.debug(`[GScore] 已转发${userType === 'group' ? '群' : '私聊'} ${event.group_id || event.user_id} 消息`);
    } catch (error) {
      pluginState.logger.error('[GScore] 发送消息失败:', error);
    }
  }

  /**
   * 将 NapCat/OneBot notice 事件转为 GScore meta 事件。
   * 标准事件仅上报 user_join_group / user_exit_group / poke。
   */
  public async forwardMetaEvent(event: Record<string, any>) {
    if (this.getStatus() !== 'connected') return;

    const meta = this.buildMetaEvent(event);
    if (!meta) {
      pluginState.logger.debug(`[GScore] 已忽略非标准 notice 事件: notice_type=${event.notice_type || ''}, sub_type=${event.sub_type || ''}`);
      return;
    }

    const groupId = meta.data.group_id ? String(meta.data.group_id) : null;
    const userId = meta.data.user_id ? String(meta.data.user_id) : '';
    const userType = groupId ? 'group' : 'direct';
    const userPm = this.getUserPermission(userId);

    const messageReceive = {
      bot_id: this.getBotId(),
      bot_self_id: this.getBotSelfId(event.self_id),
      msg_id: '',
      user_type: userType,
      group_id: groupId,
      user_id: userId,
      sender: {},
      user_pm: userPm,
      content: [{ type: `meta-${meta.eventName}`, data: meta.data }],
    };

    this.sendMessageReceive(messageReceive);
    pluginState.logger.info(`[GScore] 已上报 meta 事件: ${meta.eventName} ${JSON.stringify(meta.data)}`);
  }

  private buildMetaEvent(event: Record<string, any>): { eventName: string; data: Record<string, string> } | null {
    if (event.post_type !== 'notice') return null;

    const noticeType = String(event.notice_type || '');
    const subType = event.sub_type !== undefined ? String(event.sub_type) : undefined;

    if (noticeType === 'group_increase') {
      const userId = this.stringifyId(event.user_id);
      const groupId = this.stringifyId(event.group_id);
      if (!userId || !groupId) return null;

      const data: Record<string, string> = {
        user_id: userId,
        group_id: groupId,
      };
      const operatorId = this.stringifyId(event.operator_id);
      if (operatorId) data.operator_id = operatorId;
      if (subType) data.sub_type = subType;

      return { eventName: 'user_join_group', data };
    }

    if (noticeType === 'group_decrease') {
      const userId = this.stringifyId(event.user_id);
      const groupId = this.stringifyId(event.group_id);
      if (!userId || !groupId) return null;

      const data: Record<string, string> = {
        user_id: userId,
        group_id: groupId,
      };
      const operatorId = this.stringifyId(event.operator_id);
      if (operatorId) data.operator_id = operatorId;
      if (subType) data.sub_type = subType;

      return { eventName: 'user_exit_group', data };
    }

    if (noticeType === 'notify' && subType === 'poke') {
      const userId = this.stringifyId(event.user_id);
      if (!userId) return null;

      const data: Record<string, string> = {
        user_id: userId,
        target_id: this.stringifyId(event.target_id) || this.getBotSelfId(event.self_id),
      };
      const groupId = this.stringifyId(event.group_id);
      if (groupId) data.group_id = groupId;

      return { eventName: 'poke', data };
    }

    return null;
  }

  private stringifyId(value: unknown): string {
    if (value === null || value === undefined || value === '') return '';
    return String(value);
  }

  private getUserPermission(userId: string): number {
    const masterQQ = pluginState.config.masterQQ;
    const masters = masterQQ ? String(masterQQ).split(',').map(qq => qq.trim()).filter(Boolean) : [];
    return userId && masters.includes(userId) ? 1 : 6;
  }

  /**
   * 将 OB11 消息段数组转换为 GsCore 的 Message[] 格式
   * GsCore Message: { type: string, data: any }
   */
  private async convertOB11ToGsCoreContent(event: OB11Message): Promise<GsCoreContent> {
    const content: GsCoreContent = [];
    const message = event.message;

    if (!message || !Array.isArray(message)) {
      // 如果没有 message 数组，使用 raw_message 作为文本
      if (event.raw_message) {
        content.push({ type: 'text', data: event.raw_message });
      }
      return content;
    }

    for (const seg of message) {
      const segData = seg.data as Record<string, unknown> | undefined;
      switch (seg.type) {
        case 'text':
          content.push({ type: 'text', data: segData?.text || '' });
          break;
        case 'image':
          // 图片：GsCore 接收时一般为 url
          content.push({ type: 'image', data: segData?.url || segData?.file || '' });
          break;
        case 'at':
          content.push({ type: 'at', data: String(segData?.qq || '') });
          break;
        case 'reply':
          // 引用上下文需要通过 get_msg 解析，在当前消息转换完成后追加。
          break;
        case 'forward':
        case 'forward_msg': {
          const forwardId = this.stringifyId(segData?.id ?? segData?.message_id ?? segData?.resid);
          const nodeItems = await this.fetchForwardItems(forwardId);
          content.push({ type: 'node', data: nodeItems });
          break;
        }
        case 'face':
          // 表情转为文本占位
          content.push({ type: 'text', data: `[表情:${segData?.id || ''}]` });
          break;
        case 'record':
          content.push({ type: 'record', data: segData?.url || segData?.file || '' });
          break;
        case 'video':
          content.push({ type: 'video', data: segData?.url || segData?.file || '' });
          break;
        case 'file':
          if (event.message_type === 'private') {
            if (!pluginState.config.privateFileForwardEnabled) {
              pluginState.logger.debug('[GScore] 私聊文件转发开关关闭，已跳过 file 段');
              break;
            }

            try {
              const ctx = pluginState.ctx;
              const fileIdRaw = segData?.file_id ?? segData?.fid ?? segData?.file;
              const fileId = String(fileIdRaw || '').trim();

              if (!fileId) {
                pluginState.logger.warn('[GScore] 私聊 file 段缺少 file_id，无法获取链接，已跳过');
                break;
              }

              const resp = await ctx.actions.call(
                'get_private_file_url',
                {
                  user_id: String(event.user_id || ''),
                  file_id: fileId,
                },
                ctx.adapterName,
                ctx.pluginManager.config
              ) as { url?: string };

              const fileUrl = typeof resp?.url === 'string' ? resp.url.trim() : '';
              if (!fileUrl) {
                pluginState.logger.warn('[GScore] get_private_file_url 未返回有效 url，已跳过私聊 file 段');
                break;
              }

              const fileName = String(segData?.file || 'file').trim() || 'file';

              // 私聊 JSON 文件：仅在开关开启时转裸 base64，否则沿用文件 URL 转发
              const isJsonFile = fileName.toLowerCase().endsWith('.json');
              if (isJsonFile && pluginState.config.privateJsonBase64Enabled) {
                try {
                  const maxKbRaw = pluginState.config.privateJsonBase64MaxKb;
                  const maxKb = typeof maxKbRaw === 'number' && Number.isFinite(maxKbRaw) && maxKbRaw > 0 ? maxKbRaw : 1024;
                  const maxBytes = Math.floor(maxKb * 1024);

                  const response = await fetch(fileUrl);
                  if (!response.ok) {
                    pluginState.logger.warn(`[GScore] 下载私聊 JSON 文件失败: status=${response.status}，已跳过 file 段`);
                    break;
                  }

                  const buffer = Buffer.from(await response.arrayBuffer());
                  const fileSize = buffer.byteLength;

                  if (fileSize > maxBytes) {
                    pluginState.logger.warn(`[GScore] 私聊 JSON 文件过大(${fileSize} bytes > ${maxBytes} bytes)，已跳过 file 段`);
                    await ctx.actions.call(
                      'send_msg',
                      {
                        message_type: 'private',
                        user_id: String(event.user_id || ''),
                        message: `⚠️ JSON 过大（${(fileSize / 1024).toFixed(1)}KB），超过限制 ${maxKb}KB，已跳过转发`
                      },
                      ctx.adapterName,
                      ctx.pluginManager.config
                    );
                    break;
                  }

                  const fileBase64Raw = buffer.toString('base64');
                  content.push({ type: 'file', data: `${fileName}|${fileBase64Raw}` });
                } catch (error) {
                  pluginState.logger.warn('[GScore] 处理私聊 JSON 文件失败，已跳过 file 段:', error);
                }
              } else {
                content.push({ type: 'file', data: `${fileName}|${fileUrl}` });
              }
            } catch (error) {
              pluginState.logger.warn('[GScore] 获取私聊文件链接失败，已跳过 file 段:', error);
            }
          } else {
            content.push({ type: 'file', data: `${segData?.file || 'file'}|${segData?.url || ''}` });
          }
          break;
        default:
          // 其他未知类型，尝试转为文本
          if (segData?.text) {
            content.push({ type: 'text', data: segData.text });
          }
          break;
      }
    }

    return content;
  }

  private extractPlainText(segments: unknown[], fallback?: unknown): string {
    const parts: string[] = [];
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue;
      const seg = segment as Record<string, any>;
      if (seg.type === 'text') {
        parts.push(String(seg.data?.text || ''));
      }
    }
    if (parts.length > 0) return parts.join('');
    return typeof fallback === 'string' ? fallback : '';
  }

  private stripForwardCqCode(text: string): string {
    return text
      .replace(/\[CQ:forward,[^\]]*\]/gi, '')
      .trim();
  }

  private extractImages(segments: unknown[]): string[] {
    const images: string[] = [];
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue;
      const seg = segment as Record<string, any>;
      if (seg.type !== 'image') continue;
      const image = String(seg.data?.url || seg.data?.file || '').trim();
      if (image) images.push(image);
    }
    return images;
  }

  private async extractForwardNodes(segments: unknown[]): Promise<GsCoreContent> {
    const items: GsCoreContent = [];
    const seen = new Set<string>();
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue;
      const seg = segment as Record<string, any>;
      if (seg.type !== 'forward' && seg.type !== 'forward_msg') continue;
      const forwardId = this.stringifyId(seg.data?.id ?? seg.data?.message_id ?? seg.data?.resid);
      items.push(...await this.fetchForwardItems(forwardId, 0, seen));
    }
    return items;
  }

  private async fetchForwardItems(forwardId: string, depth: number = 0, seen: Set<string> = new Set()): Promise<GsCoreContent> {
    if (!forwardId || depth >= NODE_MAX_DEPTH || seen.has(forwardId)) {
      return [{ type: 'text', data: NODE_MARK }];
    }

    seen.add(forwardId);
    try {
      const ctx = pluginState.ctx;
      const raw = await ctx.actions.call(
        'get_forward_msg',
        { id: forwardId },
        ctx.adapterName,
        ctx.pluginManager.config
      );
      return await this.parseForwardPayload(raw, depth, seen);
    } catch (error) {
      pluginState.logger.warn(`[GScore] 展开合并转发失败 id=${forwardId}:`, error);
      return [{ type: 'text', data: NODE_MARK }];
    }
  }

  private async parseForwardPayload(raw: unknown, depth: number, seen: Set<string>): Promise<GsCoreContent> {
    const envelope = raw && typeof raw === 'object' ? raw as Record<string, any> : null;
    const messages = Array.isArray(raw)
      ? raw
      : Array.isArray(envelope?.messages)
        ? envelope.messages
        : Array.isArray(envelope?.data?.messages)
          ? envelope.data.messages
          : null;

    if (!messages) return [{ type: 'text', data: NODE_MARK }];

    const items: GsCoreContent = [];
    for (const entry of messages) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, any>;
      const payload = record.type === 'node' && record.data && typeof record.data === 'object'
        ? record.data as Record<string, any>
        : record;
      const nickname = String(payload.sender?.nickname || payload.name || payload.nickname || '').trim();
      if (nickname) items.push({ type: 'text', data: `${nickname}:` });

      const nodeContent = payload.content ?? payload.message;
      if (typeof nodeContent === 'string' && nodeContent) {
        items.push({ type: 'text', data: nodeContent });
      } else if (Array.isArray(nodeContent)) {
        items.push(...await this.convertForwardSegments(nodeContent, depth, seen));
      }
    }

    return items.length > 0 ? items : [{ type: 'text', data: NODE_MARK }];
  }

  private async convertForwardSegments(segments: unknown[], depth: number, seen: Set<string>): Promise<GsCoreContent> {
    const items: GsCoreContent = [];
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue;
      const seg = segment as Record<string, any>;
      const data = seg.data && typeof seg.data === 'object' ? seg.data as Record<string, any> : {};

      switch (seg.type) {
        case 'text':
          items.push({ type: 'text', data: String(data.text || '') });
          break;
        case 'image': {
          const image = String(data.url || data.file || '').trim();
          if (image) items.push({ type: 'image', data: image });
          break;
        }
        case 'at':
          items.push({ type: 'at', data: String(data.qq || '') });
          break;
        case 'record':
        case 'video': {
          const media = String(data.url || data.file || '').trim();
          if (media) items.push({ type: seg.type, data: media });
          break;
        }
        case 'file': {
          const fileName = String(data.name || data.file || 'file');
          const fileContent = String(data.url || '').trim();
          if (fileContent) items.push({ type: 'file', data: `${fileName}|${fileContent}` });
          break;
        }
        case 'forward':
        case 'forward_msg': {
          items.push({ type: 'text', data: NODE_MARK });
          const nestedId = this.stringifyId(data.id ?? data.message_id ?? data.resid);
          items.push(...await this.fetchForwardItems(nestedId, depth + 1, seen));
          break;
        }
      }
    }
    return items;
  }

  private formatNodePreview(items: GsCoreContent): string {
    const lines = [NODE_MARK];
    let pendingSpeaker = '';

    for (const item of items) {
      let content = '';
      if (item.type === 'text') {
        const text = String(item.data || '').trim();
        if (!text || text === NODE_MARK) continue;

        if (/[:：]$/.test(text)) {
          pendingSpeaker = text.slice(0, -1).trim();
          continue;
        }
        content = text;
      } else if (item.type === 'image') content = '[图片]';
      else if (item.type === 'record') content = '[语音]';
      else if (item.type === 'video') content = '[视频]';
      else if (item.type === 'file') content = '[文件]';

      if (content) {
        lines.push(pendingSpeaker ? `${pendingSpeaker}：${content}` : content);
        pendingSpeaker = '';
      }
    }

    return lines.join('\n');
  }

  private extractNodeImages(items: GsCoreContent): string[] {
    return items
      .filter((item) => item.type === 'image')
      .map((item) => String(item.data || '').trim())
      .filter(Boolean);
  }

  // ==================== GsCore 消息接收处理 ====================

  /**
   * 处理 GsCore 发回的 MessageSend 消息
   * 将其转换为 OB11 格式并通过 NapCat API 发送到 QQ
   */
  private async handleGsCoreMessage(msgSend: GsCoreMessageSend) {
    const { target_type, target_id, content } = msgSend;

    if (!content || content.length === 0) {
      pluginState.logger.debug('[GScore] 收到空消息，忽略');
      return;
    }

    const firstMsg = content[0];

    // 控制消息必须在普通发送分发前短路，避免误发为空消息/文本消息。
    if (content.length === 1 && firstMsg.type === 'excute_delete_message') {
      await this.handleDeleteMessageControl(msgSend, firstMsg);
      return;
    }

    if (content.length === 1 && firstMsg.type === 'excute_ban_user') {
      await this.handleBanUserControl(firstMsg);
      return;
    }

    // 检查是否为 log 类型消息（仅输出日志不发送）
    if (firstMsg.type && firstMsg.type.startsWith('log_')) {
      const level = firstMsg.type.replace('log_', '').toLowerCase();
      const logData = String(firstMsg.data || '');
      switch (level) {
        case 'info':
          pluginState.logger.info(`[GScore Log] ${logData}`);
          break;
        case 'warning':
          pluginState.logger.warn(`[GScore Log] ${logData}`);
          break;
        case 'error':
          pluginState.logger.error(`[GScore Log] ${logData}`);
          break;
        case 'success':
          pluginState.logger.info(`[GScore Log] ✅ ${logData}`);
          break;
        default:
          pluginState.logger.debug(`[GScore Log] [${level}] ${logData}`);
      }
      return;
    }

    if (!target_id) {
      pluginState.logger.warn('[GScore] 收到消息但没有 target_id，无法发送');
      if (msgSend.echo) {
        await this.sendRecallReceipt(msgSend, null);
      }
      return;
    }

    try {
      // 将 GsCore Message[] 转换为 OB11 消息段
      const ob11Message = this.convertGsCoreToOB11(content);

      if (ob11Message.length === 0) {
        pluginState.logger.debug('[GScore] 转换后消息为空，忽略');
        if (msgSend.echo) {
          await this.sendRecallReceipt(msgSend, null);
        }
        return;
      }

      const ctx = pluginState.ctx;

      let recallId: RecallMessageId = null;

      // 根据 target_type 决定发送目标
      if (target_type === 'direct') {
        // 私聊消息
        const params: OB11PostSendMsg = {
          message: ob11Message as OB11PostSendMsg['message'],
          message_type: 'private',
          user_id: target_id,
        };
        const ret = await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        recallId = this.extractMessageId(ret);
        pluginState.logger.debug(`[GScore] 已发送私聊消息到 ${target_id}`);
      } else {
        // 群消息（group/channel/sub_channel 都走群发送）
        const params: OB11PostSendMsg = {
          message: ob11Message as OB11PostSendMsg['message'],
          message_type: 'group',
          group_id: target_id,
        };
        const ret = await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        recallId = this.extractMessageId(ret);
        pluginState.logger.debug(`[GScore] 已发送群消息到 ${target_id}`);
      }

      if (msgSend.echo) {
        await this.sendRecallReceipt(msgSend, recallId);
      }
    } catch (error) {
      pluginState.logger.error('[GScore] 发送回复消息失败:', error);
      if (msgSend.echo) {
        await this.sendRecallReceipt(msgSend, null);
      }
    }
  }

  private extractMessageId(ret: unknown): RecallMessageId {
    if (!ret || typeof ret !== 'object') return null;
    const data = ret as Record<string, any>;
    const messageId = data.message_id ?? data.msg_id ?? data.id;
    if (Array.isArray(messageId)) {
      return messageId
        .filter((id) => id !== null && id !== undefined && id !== '')
        .map((id) => String(id));
    }
    if (messageId === null || messageId === undefined || messageId === '') return null;
    return String(messageId);
  }

  private async sendRecallReceipt(msgSend: GsCoreMessageSend, recallId: RecallMessageId) {
    try {
      this.sendMessageReceive({
        bot_id: msgSend.bot_id,
        bot_self_id: msgSend.bot_self_id,
        msg_id: '',
        user_type: msgSend.target_type || null,
        group_id: msgSend.target_type === 'group' ? msgSend.target_id : null,
        user_id: msgSend.target_type === 'direct' ? msgSend.target_id : '',
        sender: {},
        user_pm: 6,
        content: [{
          type: 'recall_message_id',
          data: {
            echo: msgSend.echo,
            id: recallId,
          },
        }],
      });
      pluginState.logger.debug(`[GScore] 已回传撤回回执: echo=${msgSend.echo}, id=${JSON.stringify(recallId)}`);
    } catch (error) {
      pluginState.logger.warn('[GScore] 回传撤回回执失败:', error);
    }
  }

  private async handleDeleteMessageControl(msgSend: GsCoreMessageSend, control: GsCoreMessage) {
    const data = control.data;
    const messageId = data && typeof data === 'object' ? (data as Record<string, unknown>).message_id : null;
    if (messageId === null || messageId === undefined || messageId === '') {
      pluginState.logger.warn('[GScore] 撤回控制包缺少 message_id，已忽略');
      return;
    }

    try {
      const ctx = pluginState.ctx;
      await ctx.actions.call(
        'delete_msg',
        { message_id: Number.isNaN(Number(messageId)) ? String(messageId) : Number(messageId) },
        ctx.adapterName,
        ctx.pluginManager.config
      );
      pluginState.logger.debug(`[GScore] 已撤回消息: ${messageId} target=${msgSend.target_type}:${msgSend.target_id}`);
    } catch (error) {
      pluginState.logger.warn(`[GScore] 撤回消息失败 message_id=${messageId}:`, error);
    }
  }

  private async handleBanUserControl(control: GsCoreMessage) {
    const data = control.data;
    if (!data || typeof data !== 'object') {
      pluginState.logger.warn('[GScore] 禁言控制包 data 非对象，已忽略');
      return;
    }

    const payload = data as Record<string, unknown>;
    const userId = payload.user_id;
    const groupId = payload.group_id;
    const duration = payload.duration;

    const durationValid = typeof duration === 'number'
      || (typeof duration === 'string' && /^\d+$/.test(duration));
    if (userId === null || userId === undefined || userId === ''
      || groupId === null || groupId === undefined || groupId === ''
      || !durationValid) {
      pluginState.logger.warn('[GScore] 禁言控制包字段不完整或 duration 非法，已忽略');
      return;
    }

    try {
      const ctx = pluginState.ctx;
      await ctx.actions.call(
        'set_group_ban',
        {
          group_id: Number(groupId),
          user_id: Number(userId),
          duration: Number(duration),
        },
        ctx.adapterName,
        ctx.pluginManager.config
      );
      pluginState.logger.debug(`[GScore] 已执行禁言: group=${groupId}, user=${userId}, duration=${duration}`);
    } catch (error) {
      pluginState.logger.warn(`[GScore] 禁言失败 group=${groupId}, user=${userId}:`, error);
    }
  }

  /**
   * 将 GsCore Message[] 转换为 OB11 消息段数组
   */
  private convertGsCoreToOB11(content: GsCoreMessage[]): Array<{ type: string; data: Record<string, unknown> }> {
    const result: Array<{ type: string; data: Record<string, unknown> }> = [];

    for (const msg of content) {
      if (!msg.type || msg.data === null || msg.data === undefined) continue;

      switch (msg.type) {
        case 'text':
          result.push({ type: 'text', data: { text: String(msg.data) } });
          break;

        case 'image': {
          const imgData = String(msg.data);
          const customSummary = pluginState.config.customImageSummary;
          let summary = '[图片]'; // 默认值

          if (customSummary && customSummary.trim().length > 0) {
            const summaries = customSummary.split(',').map(s => s.trim()).filter(s => s.length > 0);
            if (summaries.length > 0) {
              summary = summaries[Math.floor(Math.random() * summaries.length)];
            }
          }

          const imageData: { file: string; summary?: string } = { file: '' };

          if (imgData.startsWith('base64://')) {
            imageData.file = imgData;
          } else if (imgData.startsWith('link://')) {
            imageData.file = imgData.replace('link://', '');
          } else {
            imageData.file = imgData;
          }

          // 仅在 imageData.file 有效时才添加 summary
          if (imageData.file) {
            imageData.summary = summary;
          }

          result.push({ type: 'image', data: imageData });
          break;
        }

        case 'at':
          result.push({ type: 'at', data: { qq: String(msg.data) } });
          break;

        case 'reply':
        case 'reply_id':
          result.push({ type: 'reply', data: { id: String(msg.data) } });
          break;

        case 'record': {
          const recData = String(msg.data);
          result.push({ type: 'record', data: { file: recData } });
          break;
        }

        case 'video':
          result.push({ type: 'video', data: { file: String(msg.data) } });
          break;

        case 'file': {
          const fileStr = String(msg.data);
          const sepIdx = fileStr.indexOf('|');
          if (sepIdx > 0) {
            const fileName = fileStr.substring(0, sepIdx).trim() || 'file';
            const fileContentRaw = fileStr.substring(sepIdx + 1).trim();

            let fileData = '';
            if (fileContentRaw.startsWith('base64://')) {
              fileData = fileContentRaw;
            } else if (fileContentRaw.startsWith('link://')) {
              fileData = fileContentRaw.replace('link://', '');
            } else if (/^https?:\/\//i.test(fileContentRaw)) {
              fileData = fileContentRaw;
            } else if (fileContentRaw.length > 0) {
              fileData = `base64://${fileContentRaw}`;
            }

            if (fileData) {
              result.push({ type: 'file', data: { file: fileData, name: fileName } });
            }
          }
          break;
        }

        case 'markdown':
          // Markdown 消息：NapCat 不直接支持 markdown 消息段，转为文本
          result.push({ type: 'text', data: { text: String(msg.data) } });
          break;

        case 'node': {
          // 合并转发里的子消息
          if (Array.isArray(msg.data)) {
            const subMessagesRaw = msg.data as GsCoreMessage[];
            // 遍历每个子消息，将其分别包装为 node 节点
            for (const subMsg of subMessagesRaw) {
              const ob11Segments = this.convertGsCoreToOB11([subMsg]);

              if (ob11Segments.length > 0) {
                // 构造 node 节点
                let userId = `3889929917`;
                let nickname = `小助手`;

                // 使用自定义配置
                if (pluginState.config.customForwardInfo) {
                  const customQQ = pluginState.config.customForwardQQ;
                  const customName = pluginState.config.customForwardName;

                  if (customQQ && customQQ.trim()) {
                    userId = customQQ.trim();
                  } else {
                    userId = String(pluginState.selfId || '3889929917');
                  }

                  if (customName && customName.trim()) {
                    nickname = customName.trim();
                  } else {
                    nickname = String(pluginState.selfNickname || '小助手');
                  }
                }

                result.push({
                  type: 'node',
                  data: {
                    user_id: userId,
                    nickname: nickname,
                    content: ob11Segments
                  }
                });
              }
            }
          }
          break;
        }

        case 'image_size':
          // 图片大小信息，OB11 不需要，忽略
          break;

        case 'buttons':
        case 'template_buttons':
        case 'template_markdown':
        case 'group':
          // 按钮、模板消息、内部群号标记等，QQ 群聊不需要，忽略
          break;

        default:
          // 未知类型，如果有可显示内容就转为文本
          if (msg.data && typeof msg.data === 'string' && msg.data.length > 0) {
            result.push({ type: 'text', data: { text: msg.data } });
          }
          break;
      }
    }

    return result;
  }
}


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
}

export class GScoreService {
  private static instance: GScoreService;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_DELAY = 30000;
  private readonly MIN_RECONNECT_DELAY = 1000;

  private constructor() { }

  public static getInstance(): GScoreService {
    if (!GScoreService.instance) {
      GScoreService.instance = new GScoreService();
    }
    return GScoreService.instance;
  }

  public getStatus(): 'connected' | 'connecting' | 'disconnected' {
    if (this.ws?.readyState === WebSocket.OPEN) return 'connected';
    if (this.isConnecting || this.ws?.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'disconnected';
  }

  public connect() {
    if (!pluginState.config.gscoreEnable) {
      this.disconnect();
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) return;

    this.isConnecting = true;
    let url = pluginState.config.gscoreUrl || 'ws://localhost:8765';

    // 确保 url 不以 / 结尾
    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }

    // 使用固定的 bot_id: "napcat"
    // 如果 url 不包含 /ws/，则拼接 /ws/napcat
    if (!url.includes('/ws/')) {
      url = `${url}/ws/napcat`;
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

      this.ws.on('open', () => {
        pluginState.logger.info('[GScore] 连接成功！');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
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
        pluginState.logger.error('[GScore] 连接错误:', err.message);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnecting = false;
        this.ws = null;
        pluginState.logger.warn(`[GScore] 连接关闭: ${code} ${reason}`);
        this.scheduleReconnect();
      });

    } catch (error) {
      pluginState.logger.error('[GScore] 创建连接失败:', error);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  public disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
  }

  private scheduleReconnect() {
    if (!pluginState.config.gscoreEnable) return;

    const maxAttempts = pluginState.config.maxReconnectAttempts ?? 10;

    // maxAttempts 为 0 时表示无限重试
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      pluginState.logger.error(`[GScore] 重连次数已达上限 (${maxAttempts})，停止重连。请检查配置或手动重试。`);
      return;
    }

    // 使用配置的重连间隔，如果没配置则默认 5000ms
    const interval = pluginState.config.reconnectInterval ?? 5000;

    const attemptInfo = maxAttempts > 0 ? `${this.reconnectAttempts + 1}/${maxAttempts}` : `${this.reconnectAttempts + 1}/∞`;
    pluginState.logger.info(`[GScore] ${interval / 1000} 秒后尝试重连 (${attemptInfo})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, interval);
  }

  /**
   * 将 OB11 消息转发到 GsCore
   * 按照早柚协议文档，将 OB11 消息转换为 MessageReceive 格式
   */
  public forwardMessage(event: OB11Message) {
    if (this.getStatus() !== 'connected') return;

    // 仅转发群消息和私聊消息
    if (event.message_type !== 'group' && event.message_type !== 'private') return;

    try {
      // 将 OB11 message 段转换为 GsCore 的 Message[] (content)
      const content = this.convertOB11ToGsCoreContent(event);

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
        bot_id: 'onebot',
        bot_self_id: String(pluginState.selfId || event.self_id || ''),
        msg_id: String(event.message_id || ''),
        user_type: userType,
        group_id: event.group_id ? String(event.group_id) : null,
        user_id: String(event.user_id),
        sender: sender ? {
          ...sender,
          user_id: sender.user_id ? String(sender.user_id) : String(event.user_id),
          nickname: sender.nickname || sender.card || '',
        } : {},
        user_pm: userPm,
        content: content,
      };

      const payload = JSON.stringify(messageReceive);
      // GsCore 使用 receive_bytes()，需要发送二进制帧
      this.ws?.send(Buffer.from(payload));
      pluginState.logger.debug(`[GScore] 已转发${userType === 'group' ? '群' : '私聊'} ${event.group_id || event.user_id} 消息`);
    } catch (error) {
      pluginState.logger.error('[GScore] 发送消息失败:', error);
    }
  }

  /**
   * 将 OB11 消息段数组转换为 GsCore 的 Message[] 格式
   * GsCore Message: { type: string, data: any }
   */
  private convertOB11ToGsCoreContent(event: OB11Message): Array<{ type: string; data: unknown }> {
    const content: Array<{ type: string; data: unknown }> = [];
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
          content.push({ type: 'reply', data: String(segData?.id || '') });
          break;
        case 'face':
          // 表情转为文本占位
          content.push({ type: 'text', data: `[表情:${segData?.id || ''}]` });
          break;
        case 'record':
          content.push({ type: 'record', data: segData?.url || segData?.file || '' });
          break;
        case 'file':
          content.push({ type: 'file', data: `${segData?.name || 'file'}|${segData?.url || ''}` });
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

    // 检查是否为 log 类型消息（仅输出日志不发送）
    const firstMsg = content[0];
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
      return;
    }

    try {
      // 将 GsCore Message[] 转换为 OB11 消息段
      const ob11Message = this.convertGsCoreToOB11(content);

      if (ob11Message.length === 0) {
        pluginState.logger.debug('[GScore] 转换后消息为空，忽略');
        return;
      }

      const ctx = pluginState.ctx;

      // 根据 target_type 决定发送目标
      if (target_type === 'direct') {
        // 私聊消息
        const params: OB11PostSendMsg = {
          message: ob11Message as OB11PostSendMsg['message'],
          message_type: 'private',
          user_id: target_id,
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        pluginState.logger.debug(`[GScore] 已发送私聊消息到 ${target_id}`);
      } else {
        // 群消息（group/channel/sub_channel 都走群发送）
        const params: OB11PostSendMsg = {
          message: ob11Message as OB11PostSendMsg['message'],
          message_type: 'group',
          group_id: target_id,
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        pluginState.logger.debug(`[GScore] 已发送群消息到 ${target_id}`);
      }
    } catch (error) {
      pluginState.logger.error('[GScore] 发送回复消息失败:', error);
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
          if (imgData.startsWith('base64://')) {
            // base64 图片
            result.push({ type: 'image', data: { file: imgData } });
          } else if (imgData.startsWith('link://')) {
            // URL 图片（GsCore 可能用 link:// 前缀）
            result.push({ type: 'image', data: { file: imgData.replace('link://', '') } });
          } else if (imgData.startsWith('http')) {
            // 直接 URL
            result.push({ type: 'image', data: { file: imgData } });
          } else {
            // 其他格式，直接传递
            result.push({ type: 'image', data: { file: imgData } });
          }
          break;
        }

        case 'at':
          result.push({ type: 'at', data: { qq: String(msg.data) } });
          break;

        case 'reply':
          result.push({ type: 'reply', data: { id: String(msg.data) } });
          break;

        case 'record': {
          const recData = String(msg.data);
          result.push({ type: 'record', data: { file: recData } });
          break;
        }

        case 'file': {
          // GsCore file 格式: "文件名|base64内容" 或 "文件名|link://url"
          const fileStr = String(msg.data);
          const sepIdx = fileStr.indexOf('|');
          if (sepIdx > 0) {
            const fileName = fileStr.substring(0, sepIdx);
            const fileContent = fileStr.substring(sepIdx + 1);
            // 简化处理：如果是 link:// 开头，提取 URL
            if (fileContent.startsWith('link://')) {
              result.push({ type: 'text', data: { text: `[文件: ${fileName}] ${fileContent.replace('link://', '')}` } });
            } else {
              result.push({ type: 'text', data: { text: `[文件: ${fileName}]` } });
            }
          }
          break;
        }

        case 'markdown':
          // Markdown 消息：NapCat 不直接支持 markdown 消息段，转为文本
          result.push({ type: 'text', data: { text: String(msg.data) } });
          break;

        case 'node': {
          // 合并转发里的子消息，递归转换后拼接为文本
          if (Array.isArray(msg.data)) {
            const subMessages = this.convertGsCoreToOB11(msg.data as GsCoreMessage[]);
            result.push(...subMessages);
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

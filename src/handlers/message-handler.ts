/**
 * 消息处理器
 *
 * 处理接收到的 QQ 消息事件，包含：
 * - 命令解析与分发（群开启/关闭、拉黑/取消拉黑、帮助、状态）
 * - 消息转发到 GScore
 * - 消息发送工具函数
 */

import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';

// ==================== 消息发送工具 ====================

/**
 * 发送消息（通用）
 * 根据消息类型自动发送到群或私聊
 */
export async function sendReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: event.message_type,
            ...(event.message_type === 'group' && event.group_id
                ? { group_id: String(event.group_id) }
                : {}),
            ...(event.message_type === 'private' && event.user_id
                ? { user_id: String(event.user_id) }
                : {}),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送消息失败:', error);
        return false;
    }
}

/**
 * 发送群消息
 */
export async function sendGroupMessage(
    ctx: NapCatPluginContext,
    groupId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'group',
            group_id: String(groupId),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送群消息失败:', error);
        return false;
    }
}

// ==================== 权限检查 ====================

/**
 * 检查是否有权限执行管理命令
 * 规则：
 * 1. 如果配置了 masterQQ，仅 masterQQ 有权限
 * 2. 如果未配置 masterQQ，仅群主和管理员有权限
 */
function checkPermission(event: OB11Message): boolean {
    const masterQQ = pluginState.config.masterQQ;
    // 设置了主人QQ
    if (masterQQ && String(masterQQ).trim().length > 0) {
        return String(event.user_id) === String(masterQQ).trim();
    }

    // 私聊直接通过
    if (event.message_type !== 'group') return true;
    const role = (event.sender as Record<string, unknown>)?.role;
    return role === 'admin' || role === 'owner';
}

// ==================== 消息处理主函数 ====================

/**
 * 消息处理主函数
 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    try {
        const rawMessage = event.raw_message || '';
        const messageType = event.message_type;
        const groupId = event.group_id;
        const userId = event.user_id;

        pluginState.ctx.logger.debug(`收到消息: ${rawMessage} | 类型: ${messageType}`);

        // ==================== 统一命令前缀 ====================
        const prefix = pluginState.config.commandPrefix || '#早柚';

        // --- 群开启/关闭命令 ---
        if (rawMessage === `${prefix}群开启` || rawMessage === `${prefix}群启用`) {
            if (!groupId) return void await sendReply(ctx, event, '请在群组中使用此命令');
            if (!checkPermission(event)) return void await sendReply(ctx, event, '❌ 没有权限，仅授权用户可操作');

            pluginState.updateGroupConfig(String(groupId), { enabled: true });
            await sendReply(ctx, event, '✅ 本群早柚核心适配已开启');
            return;
        }

        if (rawMessage === `${prefix}群关闭` || rawMessage === `${prefix}群禁用`) {
            if (!groupId) return void await sendReply(ctx, event, '请在群组中使用此命令');
            if (!checkPermission(event)) return void await sendReply(ctx, event, '❌ 没有权限，仅授权用户可操作');

            pluginState.updateGroupConfig(String(groupId), { enabled: false });
            await sendReply(ctx, event, '🚫 本群早柚核心适配已关闭');
            return;
        }

        // --- 拉黑/取消拉黑命令 ---
        if (rawMessage.startsWith(`${prefix}拉黑`)) {
            if (!groupId) return void await sendReply(ctx, event, '请在群组中使用此命令');
            if (!checkPermission(event)) return void await sendReply(ctx, event, '❌ 没有权限，仅授权用户可操作');

            const atTargets = extractAtTargets(event);
            if (atTargets.length === 0) {
                await sendReply(ctx, event, '❌ 请 @要拉黑的用户');
                return;
            }

            const results: string[] = [];
            for (const targetId of atTargets) {
                if (pluginState.isBlacklisted(targetId)) {
                    results.push(`⚠️ 用户 ${targetId} 已在黑名单中`);
                } else {
                    pluginState.addToBlacklist(targetId);
                    results.push(`✅ 已拉黑用户 ${targetId}`);
                }
            }
            await sendReply(ctx, event, results.join('\n'));
            return;
        }

        if (rawMessage.startsWith(`${prefix}取消拉黑`)) {
            if (!groupId) return void await sendReply(ctx, event, '请在群组中使用此命令');
            if (!checkPermission(event)) return void await sendReply(ctx, event, '❌ 没有权限，仅授权用户可操作');

            const atTargets = extractAtTargets(event);
            if (atTargets.length === 0) {
                await sendReply(ctx, event, '❌ 请 @要取消拉黑的用户');
                return;
            }

            const results: string[] = [];
            for (const targetId of atTargets) {
                if (!pluginState.isBlacklisted(targetId)) {
                    results.push(`⚠️ 用户 ${targetId} 不在黑名单中`);
                } else {
                    pluginState.removeFromBlacklist(targetId);
                    results.push(`✅ 已取消拉黑用户 ${targetId}`);
                }
            }
            await sendReply(ctx, event, results.join('\n'));
            return;
        }

        // ==================== 黑名单检查 ====================
        if (pluginState.isBlacklisted(String(userId))) {
            pluginState.ctx.logger.debug(`用户 ${userId} 在黑名单中，跳过转发`);
            return;
        }

        // ==================== 消息转发逻辑 ====================
        if (!pluginState.config.gscoreEnable) {
            // 全局 GScore 未启用，跳过转发
        } else if (messageType === 'group' && groupId) {
            // 群消息：检查群开关后转发
            if (pluginState.isGroupEnabled(String(groupId))) {
                import('../services/gscore-service').then(({ GScoreService }) => {
                    GScoreService.getInstance().forwardMessage(event);
                });
            }
        } else if (messageType === 'private') {
            // 私聊消息：直接转发到 GScore
            import('../services/gscore-service').then(({ GScoreService }) => {
                GScoreService.getInstance().forwardMessage(event);
            });
        }

        // ==================== 命令处理 ====================
        if (!rawMessage.startsWith(prefix)) return;

        const args = rawMessage.slice(prefix.length).trim().split(/\s+/);
        const subCommand = args[0]?.toLowerCase() || '';

        switch (subCommand) {
            case 'help': {
                const helpText = [
                    `[= 插件帮助 =]`,
                    `${prefix} help - 显示帮助信息`,
                    `${prefix} status - 查看连接器状态`,
                    ``,
                    `[= 管理命令 (前缀: ${prefix}) =]`,
                    `${prefix}群开启/群启用 - 开启本群早柚核心`,
                    `${prefix}群关闭/群禁用 - 关闭本群早柚核心`,
                    `${prefix}拉黑 @用户 - 拉黑用户（不转发其消息）`,
                    `${prefix}取消拉黑 @用户 - 取消拉黑用户`,
                ].join('\n');
                await sendReply(ctx, event, helpText);
                break;
            }

            case 'status': {
                const { GScoreService } = await import('../services/gscore-service');
                const gscoreStatus = GScoreService.getInstance().getStatus();
                const statusMap = {
                    'connected': '✅ 已连接',
                    'connecting': '🔄 连接中',
                    'disconnected': '❌ 未连接'
                };

                const blacklistCount = pluginState.config.blacklist.length;
                const statusText = [
                    `[= 插件状态 =]`,
                    `运行时长: ${pluginState.getUptimeFormatted()}`,
                    `GScore: ${statusMap[gscoreStatus]}`,
                    `黑名单人数: ${blacklistCount}`,
                ].join('\n');
                await sendReply(ctx, event, statusText);
                break;
            }

            default:
                break;
        }
    } catch (error) {
        pluginState.logger.error('处理消息时出错:', error);
    }
}

// ==================== 工具函数 ====================

/**
 * 从 OB11 消息段中提取所有 @目标的 QQ 号
 * 排除 @全体成员（qq === 'all'）
 */
function extractAtTargets(event: OB11Message): string[] {
    const targets: string[] = [];
    const message = event.message;
    if (!message || !Array.isArray(message)) return targets;

    for (const seg of message) {
        if (seg.type === 'at') {
            const qq = String((seg.data as Record<string, unknown>)?.qq || '');
            if (qq && qq !== 'all') {
                targets.push(qq);
            }
        }
    }
    return targets;
}

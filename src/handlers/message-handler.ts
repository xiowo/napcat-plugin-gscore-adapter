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

// ==================== 工具函数 ====================

declare const __PLUGIN_VERSION__: string;

function getPluginVersion(): string {
    return __PLUGIN_VERSION__ || 'unknown';
}

async function forwardToGScore(event: OB11Message): Promise<void> {
    try {
        const { GScoreService } = await import('../services/gscore-service');
        await GScoreService.getInstance().forwardMessage(event);
    } catch (err) {
        pluginState.logger.error('转发消息到 GScore 失败:', err);
    }
}

function stripForwardPrefix(event: OB11Message, forwardPrefix: string): OB11Message {
    if (!forwardPrefix) return event;

    const message = Array.isArray(event.message) ? [...event.message] : event.message;
    const firstTextIndex = Array.isArray(message) ? message.findIndex((seg: any) => seg.type === 'text') : -1;

    if (Array.isArray(message) && firstTextIndex >= 0) {
        const seg = message[firstTextIndex] as any;
        const text = String((seg.data as Record<string, unknown> | undefined)?.text || '');
        (message as any[])[firstTextIndex] = {
            ...seg,
            data: { ...(seg.data as Record<string, unknown> | undefined), text: text.slice(forwardPrefix.length) },
        };
    }

    return {
        ...event,
        raw_message: (event.raw_message || '').slice(forwardPrefix.length),
        message,
    } as OB11Message;
}

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
 * 1. 命令仅允许配置的 masterQQ 使用（群/私聊一致）
 * 2. 未配置 masterQQ 时无权限
 * 3. 被拉黑的用户无任何权限
 */
function checkPermission(event: OB11Message): boolean {
    const userId = String(event.user_id);

    // 检查黑名单
    if (pluginState.isBlacklisted(userId)) {
        return false;
    }

    const masterQQ = pluginState.config.masterQQ;
    const hasMaster = !!masterQQ && String(masterQQ).trim().length > 0;
    const masterQQs = hasMaster
        ? String(masterQQ).split(',').map(qq => qq.trim())
        : [];
    const isMaster = hasMaster && masterQQs.includes(userId);

    // 未配置主人时无权限
    if (!hasMaster) return false;
    return isMaster;
}

const PERMISSION_DENIED_MSG = '❌ 没有权限，仅授权用户可操作';
const PERMISSION_NO_MASTER_MSG = '❌ 没有权限，请先配置主人';

function getPermissionDeniedMessage(event: OB11Message): string {
    const masterQQ = pluginState.config.masterQQ;
    const hasMaster = !!masterQQ && String(masterQQ).trim().length > 0;
    return !hasMaster ? PERMISSION_NO_MASTER_MSG : PERMISSION_DENIED_MSG;
}

/**
 * 权限检查
 */
async function denyIfNoPermission(
    ctx: NapCatPluginContext,
    event: OB11Message
): Promise<boolean> {
    if (!checkPermission(event)) {
        if (!pluginState.config.silentNoPermission) {
            await sendReply(ctx, event, getPermissionDeniedMessage(event));
        }
        return true;
    }
    return false;
}

/**
 * 检查是否可以绕过群禁用转发
 */
function canBypassGroupDisable(event: OB11Message): boolean {
    return !!pluginState.config.masterForwardWhenDisabled && checkPermission(event);
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
        const isSelfMessage = String(userId) === String(event.self_id || pluginState.selfId || '');

        // ==================== 黑名单检查 ====================
        if (pluginState.isBlacklisted(String(userId))) {
            pluginState.ctx.logger.debug(`用户 ${userId} 在黑名单中，已忽略其消息`);
            return;
        }

        pluginState.ctx.logger.debug(`收到消息: ${rawMessage} | 类型: ${messageType}`);

        // ==================== 统一命令前缀 ====================
        const prefix = pluginState.config.commandPrefix || '#早柚';

        // --- 群开启/关闭命令 ---
        if (rawMessage === `${prefix}群开启` || rawMessage === `${prefix}群启用`) {
            if (!groupId) return void await sendReply(ctx, event, '请在群组中使用此命令');
            if (await denyIfNoPermission(ctx, event)) return;

            pluginState.updateGroupConfig(String(groupId), { enabled: true });
            await sendReply(ctx, event, '✅ 本群早柚核心适配已开启');
            return;
        }

        if (rawMessage === `${prefix}群关闭` || rawMessage === `${prefix}群禁用`) {
            if (!groupId) return void await sendReply(ctx, event, '请在群组中使用此命令');
            if (await denyIfNoPermission(ctx, event)) return;

            pluginState.updateGroupConfig(String(groupId), { enabled: false });
            await sendReply(ctx, event, '🚫 本群早柚核心适配已关闭');
            return;
        }

        // --- 上报自身消息开关 ---
        if (rawMessage === `${prefix}开启上报`) {
            if (await denyIfNoPermission(ctx, event)) return;
            pluginState.updateConfig({ forwardSelfMessage: true });
            await sendReply(ctx, event, '✅ 已开启上报自身消息');
            return;
        }

        if (rawMessage === `${prefix}关闭上报`) {
            if (await denyIfNoPermission(ctx, event)) return;
            pluginState.updateConfig({ forwardSelfMessage: false });
            await sendReply(ctx, event, '🚫 已关闭上报自身消息');
            return;
        }

        // --- 拉黑/取消拉黑命令 ---
        if (rawMessage.startsWith(`${prefix}拉黑`)) {
            if (!groupId) return void await sendReply(ctx, event, '请在群组中使用此命令');
            if (await denyIfNoPermission(ctx, event)) return;

            const atTargets = extractAtTargets(event);
            if (atTargets.length === 0) {
                await sendReply(ctx, event, '❌ 请 @要拉黑的用户');
                return;
            }

            const results: string[] = [];
            const operatorId = String(event.user_id);

            for (const targetId of atTargets) {
                // 阻止拉黑自己
                if (targetId === operatorId) {
                    results.push('❌ 你不能拉黑你自己！');
                    continue;
                }

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
            if (await denyIfNoPermission(ctx, event)) return;

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

        // ==================== 消息转发逻辑 ====================
        const shouldForwardSelf = !!pluginState.config.forwardSelfMessage;
        const shouldSkipSelf = isSelfMessage && !shouldForwardSelf;

        if (isSelfMessage) {
            pluginState.ctx.logger.debug(`收到机器人自身消息事件: forwardSelfMessage=${shouldForwardSelf}`);
        }

        if (!pluginState.config.gscoreEnable) {
            // 全局 GScore 未启用，跳过转发
        } else if (shouldSkipSelf) {
            pluginState.ctx.logger.debug('已忽略机器人自身消息转发（配置未开启）');
        } else {
            const isGroupMessage = messageType === 'group' && !!groupId;
            const isPrivateMessage = messageType === 'private';

            if (isGroupMessage) {
                const groupEnabled = pluginState.isGroupEnabled(String(groupId));
                if (!groupEnabled && !canBypassGroupDisable(event)) {
                    // 群已禁用且无权限绕过
                } else {
                    const forwardPrefix = pluginState.getGroupForwardPrefix(String(groupId));
                    if (forwardPrefix && !rawMessage.startsWith(forwardPrefix)) {
                        pluginState.ctx.logger.debug(`群 ${groupId} 消息未匹配转发前缀，已跳过`);
                    } else {
                        await forwardToGScore(stripForwardPrefix(event, forwardPrefix));
                    }
                }
            } else if (isPrivateMessage) {
                await forwardToGScore(event);
            }
        }

        // ==================== 命令处理 ====================
        if (!rawMessage.startsWith(prefix)) return;

        const args = rawMessage.slice(prefix.length).trim().split(/\s+/);
        const subCommand = args[0]?.toLowerCase() || '';

        switch (subCommand) {
            case 'help': {
                if (await denyIfNoPermission(ctx, event)) return;
                const helpText = [
                    `[= 常用命令 =]`,
                    `${prefix}help - 显示帮助信息`,
                    `${prefix}status - 查看连接器状态`,
                    `${prefix}version - 查看插件版本`,
                    `${prefix}重连 - 立即重连GScore服务`,
                    ``,
                    `[= 管理命令 =]`,
                    `${prefix}群开启/群启用 - 开启本群早柚核心`,
                    `${prefix}群关闭/群禁用 - 关闭本群早柚核心`,
                    `${prefix}开启/关闭上报 - 开启/关闭上报自身消息`,
                    `${prefix}拉黑 @用户 - 拉黑用户（不转发其消息）`,
                    `${prefix}取消拉黑 @用户 - 取消拉黑用户`,
                ].join('\n');
                await sendReply(ctx, event, helpText);
                break;
            }

            case 'status': {
                if (await denyIfNoPermission(ctx, event)) return;
                const { GScoreService } = await import('../services/gscore-service');
                const gscoreStatus = GScoreService.getInstance().getStatus();
                const statusMap = {
                    'connected': '✅ 已连接',
                    'connecting': '🔄 连接中',
                    'disconnected': '❌ 未连接'
                };

                const blacklistCount = pluginState.config.blacklist.length;
                const forwardSelfStatus = pluginState.config.forwardSelfMessage ? '✅ 已开启' : '❌ 未开启';
                const statusText = [
                    `[= 插件状态 =]`,
                    `运行时长: ${pluginState.getUptimeFormatted()}`,
                    `GScore: ${statusMap[gscoreStatus]}`,
                    `上报自身消息: ${forwardSelfStatus}`,
                    `黑名单人数: ${blacklistCount}`,
                ].join('\n');
                await sendReply(ctx, event, statusText);
                break;
            }

            case 'reconnect':
            case '重连': {
                if (await denyIfNoPermission(ctx, event)) return;
                const { GScoreService } = await import('../services/gscore-service');
                const result = await GScoreService.getInstance().manualReconnect();
                await sendReply(ctx, event, result);
                break;
            }

            case 'version': {
                const userId = String(event.user_id);
                const isAllowed = checkPermission(event) || userId === '169629556';
                if (isAllowed) {
                    await sendReply(ctx, event, `🦊插件版本: ${getPluginVersion()}`);
                } else if (!pluginState.config.silentNoPermission) {
                    await sendReply(ctx, event, getPermissionDeniedMessage(event));
                }
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

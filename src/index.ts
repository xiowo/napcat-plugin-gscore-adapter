/**
 * NapCat 插件 - 主入口
 *
 * 导出 PluginModule 接口定义的生命周期函数，NapCat 加载插件时会调用这些函数。
 *
 * 生命周期：
 *   plugin_init        → 插件加载时调用（必选）
 *   plugin_onmessage   → 收到事件时调用（需通过 post_type 判断事件类型）
 *   plugin_cleanup     → 插件卸载/重载时调用
 *
 * 配置相关：
 *   plugin_config_ui          → 导出配置 Schema，用于 WebUI 自动生成配置面板
 *   plugin_get_config         → 自定义配置读取
 *   plugin_set_config         → 自定义配置保存
 *   plugin_on_config_change   → 配置变更回调
 */

// 禁用 ws 的 optional dependencies，避免 bundle 后运行时报错
process.env.WS_NO_BUFFER_UTIL = 'true';
process.env.WS_NO_UTF_8_VALIDATE = 'true';

import type {
    PluginModule,
    PluginConfigSchema,
    NapCatPluginContext,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { EventType } from 'napcat-types/napcat-onebot/event/index';

import { buildConfigSchema } from './config';
import { pluginState } from './core/state';
import { handleMessage } from './handlers/message-handler';
import type { PluginConfig } from './types';

// ==================== 配置 UI Schema ====================

/** NapCat WebUI 读取此导出来展示配置面板 */
export let plugin_config_ui: PluginConfigSchema = [];

// ==================== 生命周期函数 ====================

/**
 * 插件初始化（必选）
 * 加载配置、注册 WebUI 配置面板、连接 GScore
 */
export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
    try {
        // 加载配置
        await pluginState.init(ctx);

        ctx.logger.info('插件初始化中...');

        plugin_config_ui = buildConfigSchema(ctx);

        // 注册 WebUI 路由
        registerWebUIRoutes(ctx);

        // 初始化 GScore 服务
        const { GScoreService } = await import('./services/gscore-service');
        if (pluginState.config.gscoreEnable) {
            GScoreService.getInstance().connect();
        }

        ctx.logger.info('插件初始化完成');
    } catch (error) {
        ctx.logger.error('插件初始化失败:', error);
    }
};

/**
 * 注册 WebUI 路由
 */
function registerWebUIRoutes(ctx: NapCatPluginContext) {
    const base = (ctx as any).router;
    if (!base) return;

    // 插件信息脚本
    if (base.get) {
        base.get('/static/plugin-info.js', (_req: any, res: any) => {
            try {
                res.type('application/javascript');
                res.send(`window.__PLUGIN_NAME__ = ${JSON.stringify(ctx.pluginName)};`);
            } catch (e) {
                res.status(500).send('// failed to generate plugin-info');
            }
        });
    }

    // 静态资源目录
    if (base.static) base.static('/static', 'webui');

    if (!base.get || !base.post) return;

    // 注册扩展页面
    if (base.page) {
        base.page({
            path: 'gscore-dashboard',
            title: 'GScore 适配器',
            icon: '🦊',
            htmlFile: 'webui/dashboard.html',
            description: '管理 GScore 连接和群组配置'
        });
    }

    // 状态接口
    base.get('/status', async (_req: any, res: any) => {
        try {
            const { GScoreService } = await import('./services/gscore-service');
            const gscoreService = GScoreService.getInstance();
            const uptime = pluginState.getUptime();
            res.json({
                code: 0,
                data: {
                    pluginName: pluginState.ctx.pluginName,
                    uptime,
                    uptimeFormatted: pluginState.getUptimeFormatted(),
                    config: pluginState.config,
                    gscoreConnected: gscoreService.isConnected(),
                    gscoreUrl: pluginState.config.gscoreUrl,
                    reconnectAttempts: gscoreService.getReconnectAttempts(),
                }
            });
        } catch (e) {
            res.json({
                code: 0,
                data: {
                    pluginName: pluginState.ctx.pluginName,
                    uptime: pluginState.getUptime(),
                    uptimeFormatted: pluginState.getUptimeFormatted(),
                    config: pluginState.config,
                    gscoreConnected: false,
                    gscoreUrl: pluginState.config.gscoreUrl,
                    reconnectAttempts: 0,
                }
            });
        }
    });

    // 群列表接口
    base.get('/groups', async (_req: any, res: any) => {
        try {
            const groups: any[] = await ctx.actions.call(
                'get_group_list',
                {},
                ctx.adapterName,
                ctx.pluginManager.config
            );
            const config = pluginState.config;

            const groupsWithConfig = (groups || []).map((group: any) => {
                const groupId = String(group.group_id);
                const groupConfig = config.groupConfigs[groupId] || {};
                return {
                    ...group,
                    enabled: groupConfig.enabled !== false
                };
            });

            res.json({ code: 0, data: groupsWithConfig });
        } catch (e) {
            ctx.logger.error('获取群列表失败:', e);
            res.status(500).json({ code: -1, message: String(e) });
        }
    });

    // 批量更新群配置接口
    base.post('/groups/bulk-config', async (req: any, res: any) => {
        try {
            let body = req.body;
            if (!body || Object.keys(body).length === 0) {
                try {
                    const raw = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: any) => data += chunk);
                        req.on('end', () => resolve(data));
                    });
                    if (raw) body = JSON.parse(raw);
                } catch (e) {
                    ctx.logger.error('解析批量配置 Body 失败:', e);
                }
            }

            const { enabled, groupIds } = body || {};
            if (typeof enabled !== 'boolean' || !Array.isArray(groupIds)) {
                return res.status(400).json({ code: -1, message: '参数错误', received: body });
            }

            const currentGroupConfigs = { ...(pluginState.config.groupConfigs || {}) };
            for (const groupId of groupIds) {
                const gid = String(groupId);
                currentGroupConfigs[gid] = { ...currentGroupConfigs[gid], enabled };
            }

            pluginState.updateConfig({ groupConfigs: currentGroupConfigs });

            ctx.logger.info(`批量更新群配置完成 | 数量: ${groupIds.length}, enabled=${enabled}`);
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('批量更新群配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });

    // 更新群配置接口
    base.post('/groups/:id/config', async (req: any, res: any) => {
        try {
            const groupId = String(req.params?.id || '');
            if (!groupId) {
                return res.status(400).json({ code: -1, message: '缺少群 ID' });
            }

            let body = req.body;
            if (!body || Object.keys(body).length === 0) {
                try {
                    const raw = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: any) => data += chunk);
                        req.on('end', () => resolve(data));
                    });
                    if (raw) body = JSON.parse(raw);
                } catch (e) {
                    ctx.logger.error(`解析群 ${groupId} 配置 Body 失败:`, e);
                }
            }

            const { enabled } = body || {};
            pluginState.updateGroupConfig(groupId, { enabled: Boolean(enabled) });
            ctx.logger.info(`群 ${groupId} 配置已更新: enabled=${enabled}`);
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('更新群配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });

    // 彩蛋配置保存接口
    base.post('/secret-config', async (req: any, res: any) => {
        try {
            let body = req.body;
            if (!body || Object.keys(body).length === 0) {
                try {
                    const raw = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: any) => data += chunk);
                        req.on('end', () => resolve(data));
                    });
                    if (raw) body = JSON.parse(raw);
                } catch (e) {
                    ctx.logger.error('解析彩蛋配置 Body 失败:', e);
                }
            }

            const { customForwardInfo, customForwardQQ, customForwardName } = body || {};
            pluginState.updateConfig({
                customForwardInfo: Boolean(customForwardInfo),
                customForwardQQ: String(customForwardQQ || ''),
                customForwardName: String(customForwardName || ''),
            });
            ctx.logger.info('彩蛋配置已更新');
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('更新彩蛋配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });
}

async function handleIncomingEvent(ctx: NapCatPluginContext, event: any): Promise<void> {
    const postType = event?.post_type;
    const isMessage = postType === EventType.MESSAGE || postType === 'message';
    const isMessageSent = postType === 'message_sent' || postType === (EventType as any).MESSAGE_SENT;
    const isNotice = postType === 'notice' || postType === (EventType as any).NOTICE;

    if (isNotice) {
        try {
            const { GScoreService } = await import('./services/gscore-service');
            await GScoreService.getInstance().forwardMetaEvent(event);
        } catch (err) {
            ctx.logger.error('转发 meta 事件到 GScore 失败:', err);
        }
        return;
    }

    if (!isMessage && !isMessageSent) return;

    if (isMessageSent && !pluginState.config.forwardSelfMessage) {
        ctx.logger.debug('已忽略机器人自身消息事件（未开启上报自身消息）');
        return;
    }

    await handleMessage(ctx, event);
}

/**
 * 消息处理
 * NapCat 的 plugin_onmessage 只接收消息事件。
 */
export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
    await handleIncomingEvent(ctx, event as any);
};

/**
 * 通用事件处理
 * notice/request/meta 等非消息事件需要通过 plugin_onevent 接收。
 */
export const plugin_onevent: PluginModule['plugin_onevent'] = async (ctx, event) => {
    await handleIncomingEvent(ctx, event as any);
};

/**
 * 插件卸载/重载
 * 断开 GScore 连接，保存配置
 */
export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
    try {
        const { GScoreService } = await import('./services/gscore-service');
        GScoreService.getInstance().disconnect();

        pluginState.cleanup();
        ctx.logger.info('插件已卸载');
    } catch (e) {
        ctx.logger.warn('插件卸载时出错:', e);
    }
};

// ==================== 配置管理钩子 ====================

/** 获取当前配置 */
export const plugin_get_config: PluginModule['plugin_get_config'] = async (_ctx) => {
    return pluginState.config;
};

/** 设置配置（完整替换，由 NapCat WebUI 调用） */
export const plugin_set_config: PluginModule['plugin_set_config'] = async (ctx, config) => {
    const oldConfig = { ...pluginState.config };

    pluginState.replaceConfig(config as PluginConfig);
    ctx.logger.info('配置已通过 WebUI 更新');

    // 检查 GScore 相关配置是否变更，若变更则重连
    const newConfig = pluginState.config;
    const gscoreKeys: (keyof PluginConfig)[] = ['gscoreUrl', 'gscoreToken', 'gscoreEnable', 'reconnectInterval', 'maxReconnectAttempts', 'disableMultiBot'];

    const needsReconnect = gscoreKeys.some(k => oldConfig[k] !== newConfig[k]);

    if (needsReconnect) {
        ctx.logger.info('检测到 GScore 配置变更，正在重新连接...');
        try {
            const { GScoreService } = await import('./services/gscore-service');

            GScoreService.getInstance().disconnect();

            if (newConfig.gscoreEnable) {
                GScoreService.getInstance().connect();
            }
        } catch (e) {
            ctx.logger.error('配置变更后重连失败:', e);
        }
    }
};

/**
 * 配置变更回调
 * 当 WebUI 中修改单个配置项时触发
 */
export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (
    ctx, _ui, key, value, _currentConfig
) => {
    try {
        pluginState.updateConfig({ [key]: value });
        ctx.logger.debug(`配置项 ${key} 已更新`);

        // GScore 相关配置变更处理
        const gscoreKeys = ['gscoreUrl', 'gscoreToken', 'gscoreEnable', 'reconnectInterval', 'maxReconnectAttempts', 'disableMultiBot'];
        if (gscoreKeys.includes(key)) {
            const { GScoreService } = await import('./services/gscore-service');

            if (pluginState.config.gscoreEnable) {
                GScoreService.getInstance().disconnect();
                GScoreService.getInstance().connect();
            } else {
                GScoreService.getInstance().disconnect();
            }
        }
    } catch (err) {
        ctx.logger.error(`更新配置项 ${key} 失败:`, err);
    }
};

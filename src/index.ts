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
 * 消息处理
 * 收到事件时调用，仅处理消息事件
 */
export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
    if (event.post_type !== EventType.MESSAGE) return;
    if (!pluginState.config.enabled) return;
    await handleMessage(ctx, event);
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
    const gscoreKeys: (keyof PluginConfig)[] = ['gscoreUrl', 'gscoreToken', 'gscoreEnable', 'reconnectInterval', 'maxReconnectAttempts'];

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
        const gscoreKeys = ['gscoreUrl', 'gscoreToken', 'gscoreEnable', 'reconnectInterval', 'maxReconnectAttempts'];
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

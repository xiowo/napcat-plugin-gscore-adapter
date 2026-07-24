/**
 * 插件配置模块
 * 定义默认配置值和 WebUI 配置 Schema
 */

import type { NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { PluginConfig } from './types';

/** 默认配置 */
export const DEFAULT_CONFIG: PluginConfig = {
    gscoreEnable: true,
    forwardSelfMessage: false,
    commandPrefix: '#早柚',
    masterQQ: '',
    groupConfigs: {},
    gscoreUrl: 'ws://localhost:8765',
    gscoreToken: '',
    reconnectInterval: 5000,
    maxReconnectAttempts: 10,
    blacklist: [],
    customImageSummary: '',
    masterForwardWhenDisabled: false,
    silentNoPermission: false,
    customForwardInfo: false,
    customForwardQQ: '',
    customForwardName: '',
    disableMultiBot: false,
    privateFileForwardEnabled: true,
    privateJsonBase64Enabled: false,
    privateJsonBase64MaxKb: 1024,
};

/**
 * 构建 WebUI 配置 Schema
 */
export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
    return ctx.NapCatConfig.combine(
        // 插件信息头部
        ctx.NapCatConfig.html(`
            <div style="position: relative; padding: 18px; background: linear-gradient(135deg, #FB7299 0%, #FF9EBC 100%); border-radius: 16px; margin-bottom: 24px; color: white; overflow: hidden; box-shadow: 0 4px 12px rgba(251, 114, 153, 0.3);">
                <div style="position: relative; z-index: 2;">
                    <h3 style="margin: 0 0 8px 0; font-size: 20px; font-weight: bold; display: flex; align-items: center;">
                        GScore 适配器
                        <span style="font-size: 24px; margin-right: 8px;">🦊</span>
                    </h3>
                    <p style="margin: 0; font-size: 14px; opacity: 0.9;">连接 GScore (早柚核心) 的适配器插件</p>
                </div>
                <div style="position: absolute; right: -10px; bottom: -15px; font-size: 80px; opacity: 0.15; transform: rotate(-15deg); pointer-events: none;">
                    🐾
                </div>
                <div style="position: absolute; right: 60px; top: -10px; font-size: 40px; opacity: 0.1; transform: rotate(15deg); pointer-events: none;">
                    🐾
                </div>
            </div>
        `),
        // GScore 配置
        ctx.NapCatConfig.html('<div style="margin: 20px 0 10px 0; font-weight: bold; border-bottom: 1px solid #ddd; padding-bottom: 5px;">GScore 连接配置</div>'),
        ctx.NapCatConfig.boolean('gscoreEnable', '启用 GScore 适配', true, '是否开启 GScore 消息转发'),
        ctx.NapCatConfig.boolean('forwardSelfMessage', '上报自身消息', false, '开启后转发机器人自己发送的消息（不懂的别开）'),
        ctx.NapCatConfig.text('gscoreUrl', '连接地址', 'ws://localhost:8765', 'GScore WebSocket 地址 (ws://...)'),
        ctx.NapCatConfig.html('<div style="font-size: 12px; color: #f59e0b; margin-top: -5px; margin-bottom: 10px;">⚠️ Docker 环境下请勿使用 localhost/127.0.0.1，请使用宿主机 IP ，双容器同自定义网络可填写容器名使用容器间DNS解析（默认的bridge网络不支持）</div>'),
        ctx.NapCatConfig.text('gscoreToken', '连接 Token', '', '连接鉴权 Token (选填)'),
        ctx.NapCatConfig.number('reconnectInterval', '重连间隔 (ms)', 5000, '断线重连的时间间隔，单位毫秒'),
        ctx.NapCatConfig.number('maxReconnectAttempts', '最大重连次数', 10, '最大尝试重连次数，设置为0则无限重连'),
        // 命令配置
        ctx.NapCatConfig.html('<div style="margin: 20px 0 10px 0; font-weight: bold; border-bottom: 1px solid #ddd; padding-bottom: 5px;">命令配置</div>'),
        ctx.NapCatConfig.text('commandPrefix', '命令前缀', '#早柚', '群内快捷命令前缀，例如设置为 "#早柚" 则命令为 "#早柚群开启"'),
        ctx.NapCatConfig.text('masterQQ', '主人QQ', '', '设置主人QQ以使用管理命令。多个QQ请用英文逗号分隔'),
        ctx.NapCatConfig.boolean('masterForwardWhenDisabled', '主人正常转发', false, '开启后群禁用仍转发主人消息'),
        ctx.NapCatConfig.boolean('silentNoPermission', '无权限静默', false, '开启后无权限用户不返回权限提示'),
        // 图片外显配置
        ctx.NapCatConfig.html('<div style="margin: 20px 0 10px 0; font-weight: bold; border-bottom: 1px solid #ddd; padding-bottom: 5px;">消息配置</div>'),
        ctx.NapCatConfig.text('customImageSummary', '图片外显', '', '用于设置图片消息的summary，多个外显文本请用英文逗号隔开，发送时将随机选择一个'),

        // 扩展兼容项
        ctx.NapCatConfig.html('<div style="margin: 20px 0 10px 0; font-weight: bold; border-bottom: 1px solid #ddd; padding-bottom: 5px;">扩展兼容项</div>'),
        ctx.NapCatConfig.boolean('disableMultiBot', '禁用多 bot 功能', false, '开启后固定使用 napcat 作为 bot_id，不再使用 napcat-QQ号；开启后nc切换账号不影响推送配置'),
        ctx.NapCatConfig.boolean('privateFileForwardEnabled', '私聊转发文件', true, '开启后私聊收到 file 消息会自动获取链接并以文件 URL 转发；关闭则不转发私聊文件消息'
        ),
        ctx.NapCatConfig.boolean('privateJsonBase64Enabled', '私聊JSON转base64发送', false, '开启后私聊收到 json 文件时会下载并转 base64 发送；关闭则按普通文件转发 URL'),
        ctx.NapCatConfig.number('privateJsonBase64MaxKb', '私聊JSON转base64大小限制(KB)', 1024, '仅在开启私聊JSON转base64发送时生效；超出限制则不转发并提示'),
    );
}

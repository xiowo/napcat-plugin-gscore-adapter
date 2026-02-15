/**
 * 类型定义文件
 * 定义插件内部使用的接口和类型
 *
 * 注意：OneBot 相关类型（OB11Message, OB11PostSendMsg 等）
 * 以及插件框架类型（NapCatPluginContext, PluginModule 等）
 * 均来自 napcat-types 包，无需在此重复定义。
 */

// ==================== 插件配置 ====================

/**
 * 插件主配置接口
 */
export interface PluginConfig {
    /** 全局开关：是否启用插件功能 */
    enabled: boolean;
    /** 早柚命令前缀，默认为 #早柚，用于群内快捷命令（如 #早柚群启用） */
    commandPrefix: string;
    /** 主人QQ，设置后仅该用户可用群内命令，留空则默认群主/管理员可用 */
    masterQQ?: string;
    /** GScore 连接地址 */
    gscoreUrl: string;
    /** GScore 连接 Token */
    gscoreToken: string;
    /** GScore 是否启用 */
    gscoreEnable: boolean;
    /** 重连间隔（毫秒） */
    reconnectInterval: number;
    /** 最大重连次数 */
    maxReconnectAttempts: number;
    /** 按群的单独配置 */
    groupConfigs: Record<string, GroupConfig>;
    /** 用户黑名单（QQ号列表），拉黑后不转发该用户消息到 GScore */
    blacklist: string[];
    /** 自定义图片外显 */
    customImageSummary?: string;
}

/**
 * 群配置
 */
export interface GroupConfig {
    /** 是否启用此群的功能 */
    enabled?: boolean;
}

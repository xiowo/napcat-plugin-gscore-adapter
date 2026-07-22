## {VERSION}

### ✨ 核心更新
- 更新版本至 {VERSION}
- 🦊添加了一点点bug

### 📦 安装说明
1. 下载 `napcat-plugin-gscore-adapter.zip`
2. 解压到 NapCat 的 `plugins` 目录
3. 重启 NapCat

### ⚠️ 注意
1. 高版本nc在插件加载器写死了白名单，如果你需要在高版本nc安装插件，请自行将 `package.json` 中的 `name` 改为nc商店白名单插件的插件id
2. 自动更新推送出现问题的，可参考 issue #3 对早柚配置进行修改（可以不删，手动改一下也行）
3. 使用`ww插件`可开启`扩展兼容项-私聊转发文件`以兼容私聊抽卡json导入
4. 容器建议映射 `/app/napcat/plugins` 和 `/app/napcat/config` 避免更新容器导致插件以及其配置丢失


> 💡 你也可以在 **[napcat-plugin-update-checker](https://github.com/xiowo/napcat-plugin-update-checker) 中直接安装插件**。


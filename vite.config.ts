import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { napcatHmrPlugin } from 'napcat-plugin-debug-cli/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

const nodeModules = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
].flat();

/** 依赖排除（如有外部依赖需排除，在此添加） */
const external: string[] = ['bufferutil', 'utf-8-validate'];

/**
 * 递归复制目录
 */
function copyDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = resolve(src, entry.name);
        const destPath = resolve(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * 构建后自动复制资源的 Vite 插件
 */
function copyAssetsPlugin() {
    return {
        name: 'copy-assets',
        writeBundle() {
            try {
                const distDir = resolve(__dirname, 'dist');

                // 复制 webui 资源
                const webuiSrc = resolve(__dirname, 'src/webui');
                const webuiDest = resolve(distDir, 'webui');
                if (fs.existsSync(webuiSrc)) {
                    copyDirRecursive(webuiSrc, webuiDest);
                    console.log('[copy-assets] (o\'v\'o) 已复制 webui 目录');
                }

                // 复制 icon.png
                const iconSrc = resolve(__dirname, 'icon.png');
                const iconDest = resolve(distDir, 'icon.png');
                if (fs.existsSync(iconSrc)) {
                    fs.copyFileSync(iconSrc, iconDest);
                    console.log('[copy-assets] (o\'v\'o) 已复制 icon.png');
                }

                // 生成精简的 package.json（只保留运行时必要字段）
                const pkgPath = resolve(__dirname, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                    const distPkg: Record<string, unknown> = {
                        name: pkg.name,
                        plugin: pkg.plugin,
                        version: pkg.version,
                        type: pkg.type,
                        main: pkg.main,
                        icon: pkg.icon,
                        description: pkg.description,
                        author: pkg.author,
                        dependencies: pkg.dependencies,
                    };
                    if (pkg.napcat) {
                        distPkg.napcat = pkg.napcat;
                    }
                    fs.writeFileSync(
                        resolve(distDir, 'package.json'),
                        JSON.stringify(distPkg, null, 2)
                    );
                    console.log('[copy-assets] (o\'v\'o) 已生成精简 package.json');
                }

                console.log('[copy-assets] (*\'v\'*) 资源复制完成！');
            } catch (error) {
                console.error('[copy-assets] (;_;) 资源复制失败:', error);
            }
        },
    };
}

export default defineConfig({
    define: {
        '__PLUGIN_VERSION__': JSON.stringify(pkg.version),
    },
    resolve: {
        conditions: ['node', 'default'],
    },
    build: {
        sourcemap: false,
        target: 'esnext',
        minify: false,
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: () => 'index.mjs',
        },
        rollupOptions: {
            external: [...nodeModules, ...external],
            output: {
                inlineDynamicImports: true,
            },
        },
        outDir: 'dist',
    },
    plugins: [nodeResolve(), copyAssetsPlugin(), napcatHmrPlugin({})],
});
  
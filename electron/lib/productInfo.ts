/**
 * 产品身份常量（本文件就是常量表，不放逻辑）。
 *
 * `PRODUCT_SITE` 是**全应用唯一出现处** —— 分享卡片二维码、关于页、更新说明
 * 一律从这里取，不要在别处再写一份字面量（契约脚本对本串做负向断言：
 * 除本文件外，`electron/` 与 `src/` 下任何源码出现该域名即失败）。
 */

/** 产品官网（GitHub Pages，gh-pages 分支） */
export const PRODUCT_SITE = 'https://lousync.github.io/Phrontis/'

/**
 * M3U8 广告过滤模块 v3.1
 * 
 * 架构：Cloudflare Worker 边缘代理过滤
 * M3U8 URL 通过 CORS_PROXY_URL (CF Worker) 路由：
 *   1. CF Worker 获取原始 M3U8 内容
 *   2. 移除所有 #EXT-X-DISCONTINUITY 标签（广告插入标记）
 *   3. 将相对 URL 重写为代理 URL（TS 分片也经过 Worker）
 *   4. 返回干净的 M3U8 给 HLS.js
 * 
 * 客户端模块负责：
 * - 提供 isEnabled() 供 play() 函数决定是否路由到代理
 * - 广告过滤 UI 开关（设置面板中的切换按钮）
 * - 设置持久化（localStorage）
 * 
 * 参考：https://github.com/eraycc/m3u8-proxy-script
 * 
 * @author DongguaTV
 * @version 3.1.0
 */

(function () {
    'use strict';

    // 调试：通过 URL 参数 ?no-adfilter 完全禁用广告过滤（包括 HLS loader）
    // 用于测试投屏等功能是否受 ad-filter 影响
    if (window.location.search.includes('no-adfilter')) {
        console.log('[广告过滤] ⚠️ 检测到 ?no-adfilter 参数，广告过滤模块已完全禁用');
        return;
    }

    // 配置
    const AD_FILTER_CONFIG = {
        enabled: true,                    // 总开关
        skipDiscontinuityAds: true,       // 跳过 DISCONTINUITY 后的广告分段
        skipFirstSegments: false,         // 是否跳过开头分段（可配置）
        firstSegmentSkipDuration: 0,      // 跳过开头的秒数（0 = 不跳过）
        minAdDuration: 3,                 // 广告最小时长（秒）
        maxAdDuration: 120,               // 广告最大时长（秒）
        maxConsecutiveAdSegments: 15,     // 广告最大连续分段数
        logEnabled: true,                 // 日志开关
        showNotification: true,           // 显示过滤通知

        // 已知广告域名模式
        adDomainPatterns: [
            // 国际广告平台
            'doubleclick',          // Google DoubleClick
            'googlesyndication',    // Google AdSense
            'googleadservices',     // Google Ads
            'adsystem',
            'adservice',

            // 国内广告平台 - 百度
            'baidu.com/adm',        // 百度广告
            'pos.baidu.com',        // 百度联盟
            'cpro.baidu',           // 百度推广
            'eclick.baidu',         // 百度点击
            'baidustatic.com/adm',

            // 国内广告平台 - 腾讯
            'gdt.qq.com',           // 腾讯广点通
            'l.qq.com',             // 腾讯广告
            'e.qq.com',             // 腾讯广告联盟
            'adsmind.gdtimg',       // 腾讯广告素材

            // 国内广告平台 - 阿里/优酷/UC
            'tanx.com',             // 阿里妈妈
            'alimama.com',          // 阿里妈妈广告
            'mmstat.com',           // 阿里统计
            'atanx.alicdn',         // 阿里广告
            'ykad.',                // 优酷广告
            'ykimg.com/material',   // 优酷广告素材
            'iusmob.',              // UC广告

            // 国内广告平台 - 字节跳动/穿山甲
            'pangle.',              // 穿山甲广告
            'pangolin.',            // 穿山甲
            'bytedance.com/ad',     // 字节广告
            'oceanengine.',         // 巨量引擎
            'csjad.',               // 穿山甲

            // 视频网站广告
            'iqiyiad.',             // 爱奇艺广告
            'iqiyi.com/cupid',      // 爱奇艺广告系统
            'cupid.iqiyi',          // 爱奇艺贴片广告
            'mgtvad.',              // 芒果TV广告
            'admaster.',            // 广告监测
            'miaozhen.',            // 秒针广告监测

            // 通用广告关键词
            'adcdn.',
            'ad-cdn.',
            '/ad/',
            '/ads/',
            'advert',
            'adsrv',
            'adpush',
            'adx.',
            'dsp.',
            'rtb.',                 // 实时竞价
            'ssp.',                 // 供应方平台
            'tracking',
            'analytics',
            'commercial',
            'insert.',
            'preroll',              // 前贴片广告
            'midroll',              // 中插广告
            'postroll'              // 后贴片广告
        ],

        // 需要保护的主流视频 CDN（不过滤这些域名）
        safeDomains: [
            // 资源站 CDN
            'hhuus.com',           // 豪华资源
            'bvvvvvvvvv1f.com',    // 暴风资源
            'play-cdn',            // 1080资源
            'modujx',              // 魔都资源
            'ffzy',                // 非凡资源
            'sdzy',                // 闪电资源
            'wujin',               // 无尽资源
            'heimuer',             // 黑木耳资源
            'lzizy',               // 量子资源

            // 主流云服务商 CDN
            'alicdn.com',
            'aliyuncs.com',
            'aliyun',
            'qcloud',
            'myqcloud.com',
            'ksyun',
            'ks-cdn',
            'huaweicloud',
            'hwcdn',
            'baidubce',
            'bcebos.com',
            'cdn.bcebos',

            // 国内 CDN 服务商
            'cdn.jsdelivr',
            'bootcdn',
            'staticfile',
            'unpkg',
            'cdnjs'
        ]
    };

    // 统计信息
    const stats = {
        totalAdsFiltered: 0,
        totalAdDuration: 0,
        sessionsFiltered: 0
    };

    // 日志函数
    const log = (...args) => {
        if (AD_FILTER_CONFIG.logEnabled) {
            console.log('[广告过滤]', ...args);
        }
    };

    /**
     * 检查 URL 是否匹配广告域名
     * @param {string} url - 要检查的 URL
     * @returns {boolean} 是否为广告域名
     */
    function isAdDomain(url) {
        if (!url) return false;
        const lowerUrl = url.toLowerCase();

        // 首先检查是否是安全域名
        for (const safe of AD_FILTER_CONFIG.safeDomains) {
            if (lowerUrl.includes(safe)) {
                return false;
            }
        }

        // 然后检查是否匹配广告域名模式
        for (const pattern of AD_FILTER_CONFIG.adDomainPatterns) {
            if (lowerUrl.includes(pattern)) {
                return true;
            }
        }

        return false;
    }

    /**
     * 注：v3.x 起广告过滤改由 Cloudflare Worker 边缘代理完成（play() 路由到 CORS_PROXY_URL）。
     * 原客户端 M3U8 解析/过滤函数 parseM3U8 / detectAdSegments / detectAdTimeRanges / filterM3U8
     * 已无任何调用方，为减小体积已移除；仅保留 isAdDomain 与 UI/开关逻辑。
     */


    /**
     * 注入广告过滤开关到设置面板 (可从外部调用)
     * @returns {boolean} 是否成功注入
     */
    function injectAdFilterUI() {
        const settingPanel = document.querySelector('.dplayer-setting-origin-panel');
        if (!settingPanel) return false;

        // 如果已经存在，不重复注入
        if (settingPanel.querySelector('.dplayer-setting-ad-filter')) {
            return true;
        }

        const html = `
            <div class="dplayer-setting-ad-filter" style="border-top: 1px solid rgba(255,255,255,0.1); margin-top: 5px; padding-top: 5px;">
                <div class="dplayer-setting-item" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;" id="ad-filter-toggle">
                    <span class="dplayer-label">广告过滤</span>
                    <div style="position: relative; width: 40px; height: 22px; background: ${AD_FILTER_CONFIG.enabled ? '#e50914' : 'rgba(255,255,255,0.2)'}; border-radius: 20px; transition: background 0.3s;">
                        <div class="ad-filter-knob" style="position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; background: #fff; border-radius: 50%; transition: transform 0.3s; transform: translateX(${AD_FILTER_CONFIG.enabled ? '18px' : '0'});"></div>
                    </div>
                </div>
            </div>
        `;
        settingPanel.insertAdjacentHTML('beforeend', html);

        // 绑定点击事件
        const toggle = settingPanel.querySelector('#ad-filter-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                AD_FILTER_CONFIG.enabled = !AD_FILTER_CONFIG.enabled;
                const bg = toggle.querySelector('div');
                const knob = toggle.querySelector('.ad-filter-knob');
                if (bg && knob) {
                    bg.style.background = AD_FILTER_CONFIG.enabled ? '#e50914' : 'rgba(255,255,255,0.2)';
                    knob.style.transform = `translateX(${AD_FILTER_CONFIG.enabled ? '18px' : '0'})`;
                }
                if (window.dp && window.dp.notice) {
                    window.dp.notice(AD_FILTER_CONFIG.enabled ? '🛡️ 广告过滤已开启' : '广告过滤已关闭');
                }
                // 保存设置
                try {
                    localStorage.setItem('donggua_ad_filter_enabled', AD_FILTER_CONFIG.enabled);
                } catch (e) { }
            });
        }

        log('✅ 广告过滤开关已注入到设置面板');
        return true;
    }

    /**
     * 创建广告过滤设置 UI
     * 使用多种策略确保按钮能正确注入到设置面板
     */
    function createSettingsUI() {
        // 策略1: 监听设置图标点击
        function setupSettingIconListener() {
            // 使用事件委托，监听整个 document 的点击
            document.addEventListener('click', (e) => {
                // 检查是否点击了设置图标
                const settingIcon = e.target.closest('.dplayer-setting-icon');
                if (settingIcon) {
                    // 延迟执行，等待 DPlayer 创建设置面板
                    setTimeout(injectAdFilterUI, 50);
                    setTimeout(injectAdFilterUI, 150);
                    setTimeout(injectAdFilterUI, 300);
                }
            }, true);
        }

        // 策略2: 使用 MutationObserver 监听整个 document.body
        function setupMutationObserver() {
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        // 检查是否有设置面板被添加
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                if (node.classList && node.classList.contains('dplayer-setting-origin-panel')) {
                                    setTimeout(injectAdFilterUI, 10);
                                } else if (node.querySelector && node.querySelector('.dplayer-setting-origin-panel')) {
                                    setTimeout(injectAdFilterUI, 10);
                                }
                            }
                        }
                    }
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // 10分钟后停止观察（防止内存泄漏）
            setTimeout(() => {
                observer.disconnect();
            }, 600000);
        }

        // 策略3: 定时检查（作为后备方案）
        function setupPeriodicCheck() {
            let attempts = 0;
            const maxAttempts = 60; // 最多检查30秒

            const checkInterval = setInterval(() => {
                attempts++;
                if (injectAdFilterUI() || attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                }
            }, 500);
        }

        // 初始化所有策略
        function init() {
            // 尝试立即注入
            injectAdFilterUI();

            // 设置点击监听
            setupSettingIconListener();

            // 设置 DOM 变更监听
            setupMutationObserver();

            // 设置后备定时检查
            setupPeriodicCheck();

            log('✅ 广告过滤 UI 监听已启动');
        }

        // 等待 DOM 准备就绪后初始化
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    /**
     * 加载保存的设置
     */
    function loadSettings() {
        try {
            const saved = localStorage.getItem('donggua_ad_filter_enabled');
            if (saved !== null) {
                AD_FILTER_CONFIG.enabled = saved === 'true';
            }
        } catch (e) { }
    }

    // 导出配置和函数到全局
    window.AdFilter = {
        config: AD_FILTER_CONFIG,
        stats,
        isAdDomain,
        isEnabled: () => AD_FILTER_CONFIG.enabled,
        enable: () => {
            AD_FILTER_CONFIG.enabled = true;
            try { localStorage.setItem('donggua_ad_filter_enabled', 'true'); } catch (e) { }
            log('广告过滤已启用');
        },
        disable: () => {
            AD_FILTER_CONFIG.enabled = false;
            try { localStorage.setItem('donggua_ad_filter_enabled', 'false'); } catch (e) { }
            log('广告过滤已禁用');
        },
        setLogEnabled: (enabled) => { AD_FILTER_CONFIG.logEnabled = enabled; },
        setNotificationEnabled: (enabled) => { AD_FILTER_CONFIG.showNotification = enabled; },
        getStats: () => ({ ...stats }),
        setSkipFirstSeconds: (seconds) => {
            AD_FILTER_CONFIG.skipFirstSegments = seconds > 0;
            AD_FILTER_CONFIG.firstSegmentSkipDuration = seconds;
        },
        initUI: injectAdFilterUI
    };

    // 初始化
    log('🚀 广告过滤模块 v3.1 加载中...');
    log('📡 架构: Cloudflare Worker 边缘代理过滤 (CORS_PROXY_URL)');
    loadSettings();
    createSettingsUI();

    log(`📊 配置: 启用=${AD_FILTER_CONFIG.enabled}, DISCONTINUITY过滤=${AD_FILTER_CONFIG.skipDiscontinuityAds}`);

})();

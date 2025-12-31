/**
 * Content Script
 * 功能：监听聊天列表变化，在新增 HR 消息时调用大模型生成回复并自动填充输入框
 */

// ============================================================================
// JD 信息获取（通过监听 historyMsg 和 getBossData API）
// ============================================================================

// 当前职位信息（来自 historyMsg，包含截断的 description）
let currentJobInfo = null;

// 当前职位数据（来自 getBossData，包含 encryptJobId 和 securityId）
let currentJobData = null;

// 当前完整职位描述（来自职位详情页）
let currentJobDescription = null;

// 触发自动回复的回调（由 watchImListAsDialogue 设置）
let triggerAutoReplyCallback = null;

/**
 * 监听来自页面的职位信息（inject.js 通过 manifest world: "MAIN" 注入）
 */
function setupJobInfoListener() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    // 处理 historyMsg 返回的职位信息
    if (event.data?.type === "BOSS_JOB_INFO") {
      const jobDesc = event.data.jobInfo;
      if (!jobDesc) return;

      currentJobInfo = {
        title: jobDesc.title || "",
        salary: jobDesc.salary || "",
        city: jobDesc.city || "",
        education: jobDesc.education || "",
        experience: jobDesc.experience || "",
        company: jobDesc.company || "",
        hrName: jobDesc.boss?.name || "",
        hrTitle: jobDesc.bossTitle || "",
        description: jobDesc.content || ""
      };

      console.log("[JD] 获取到 historyMsg 职位信息");
    }

    // 处理 getBossData 返回的职位数据（包含 encryptJobId 和 securityId）
    if (event.data?.type === "BOSS_JOB_DATA") {
      const jobData = event.data.jobData;
      if (!jobData) return;

      currentJobData = {
        encryptJobId: jobData.encryptJobId || "",
        securityId: jobData.securityId || "",
        encryptBossId: jobData.encryptBossId || "",
        jobName: jobData.jobName || "",
        salaryDesc: jobData.salaryDesc || "",
        locationName: jobData.locationName || "",
        degreeName: jobData.degreeName || "",
        experienceName: jobData.experienceName || "",
        brandName: jobData.brandName || "",
        bossName: jobData.bossName || "",
        bossTitle: jobData.bossTitle || "",
        companyName: jobData.companyName || ""
      };

      console.log("[JD] 获取到 getBossData 职位数据");

      // 职位数据已准备好，可以通过按钮手动获取完整 JD
    }
  });
}

/**
 * 获取完整职位描述（通过 background service worker 打开新标签页）
 */
function fetchFullJobDescription(callback) {
  if (!currentJobData?.encryptJobId || !currentJobData?.securityId) {
    console.log("[JD] 缺少 encryptJobId 或 securityId，跳过获取完整 JD");
    callback?.();
    return;
  }

  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
  if (!runtime?.sendMessage) {
    console.error("[JD] chrome.runtime 不可用");
    callback?.();
    return;
  }

  runtime.sendMessage({
    type: "FETCH_JOB_DETAIL",
    encryptJobId: currentJobData.encryptJobId,
    securityId: currentJobData.securityId
  }, (res) => {
    if (runtime.lastError) {
      console.error("[JD] 获取完整 JD 失败:", runtime.lastError.message);
      callback?.();
      return;
    }
    if (!res?.ok) {
      console.error("[JD] 获取完整 JD 失败:", res?.error);
      callback?.();
      return;
    }
    currentJobDescription = res.jobDescription;
    console.log("[JD] 获取到完整职位描述，长度:", currentJobDescription.length);
    callback?.();
  });
}

// 立即初始化 JD 监听
setupJobInfoListener();

// ============================================================================
// UI 悬浮菜单
// ============================================================================

// 自动回复开关状态
let autoReplyEnabled = true;

/**
 * 向输入框写入文本
 */
function fillChatInput(el, text) {
  if (!el) return;

  el.focus();
  el.innerHTML = "";

  // 优先用 execCommand
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch (_) {
    inserted = false;
  }

  // 兜底
  if (!inserted) {
    el.textContent = text;
  }

  // 光标放到末尾
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_) {
    // ignore
  }

  // 触发 input 事件
  try {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  } catch (_) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * 初始化自动回复状态
 */
function initAutoReplyState() {
  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
  if (!runtime) return;

  chrome.storage.local.get(["auto_reply_enabled"], (result) => {
    // 默认开启
    autoReplyEnabled = result.auto_reply_enabled !== false;
  });
}

/**
 * 创建悬浮菜单
 */
function createFloatingMenu() {
  // 避免重复创建
  if (document.getElementById("boss-helper-menu")) return;

  // 初始化自动回复状态
  initAutoReplyState();

  // 主容器
  const container = document.createElement("div");
  container.id = "boss-helper-menu";
  container.style.cssText = `
    position: fixed;
    bottom: 100px;
    right: 20px;
    z-index: 9999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  // 菜单面板（默认隐藏）
  const menuPanel = document.createElement("div");
  menuPanel.id = "boss-helper-menu-panel";
  menuPanel.style.cssText = `
    display: none;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 10px;
    background: white;
    border-radius: 8px;
    padding: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    min-width: 140px;
  `;

  // 菜单项
  const menuItems = [
    { icon: "📚", text: "使用教程", action: showTutorial },
    { icon: "⚙️", text: "配置API", action: showApiConfig },
    { icon: "👤", text: "个人信息", action: showProfileConfig },
    { icon: "🔄", text: "自动生成回复", action: toggleAutoReply, isToggle: true, primary: true },
    { icon: "💬", text: "生成打招呼语", action: handleGreeting, primary: true }
  ];

  menuItems.forEach((item) => {
    const menuItem = document.createElement("div");
    menuItem.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      border-radius: 6px;
      transition: background 0.2s;
      font-size: 14px;
      color: #333;
      ${item.primary ? "background: #00bebd; color: white;" : ""}
    `;

    if (item.isToggle) {
      // 开关项
      const icon = document.createElement("span");
      icon.textContent = item.icon;

      const text = document.createElement("span");
      text.textContent = item.text;
      text.style.flex = "1";

      const toggle = document.createElement("span");
      toggle.id = "boss-helper-auto-reply-toggle";
      toggle.textContent = autoReplyEnabled ? "开" : "关";
      toggle.style.cssText = `
        font-size: 12px;
        padding: 2px 6px;
        border-radius: 4px;
        background: ${autoReplyEnabled ? "#00bebd" : "#ccc"};
        color: white;
      `;

      menuItem.appendChild(icon);
      menuItem.appendChild(text);
      menuItem.appendChild(toggle);
    } else {
      menuItem.innerHTML = `<span>${item.icon}</span><span>${item.text}</span>`;
    }

    menuItem.addEventListener("mouseenter", () => {
      if (!item.primary) {
        menuItem.style.background = "#f5f5f5";
      }
    });
    menuItem.addEventListener("mouseleave", () => {
      if (!item.primary) {
        menuItem.style.background = "";
      }
    });
    menuItem.addEventListener("click", (e) => {
      e.stopPropagation();
      item.action();
      // 菜单保持打开，不自动关闭
    });

    menuPanel.appendChild(menuItem);
  });

  // 主按钮
  const mainBtn = document.createElement("button");
  mainBtn.id = "boss-helper-main-btn";
  mainBtn.innerHTML = "🤖";
  mainBtn.style.cssText = `
    width: 50px;
    height: 50px;
    border-radius: 50%;
    background: #00bebd;
    color: white;
    border: none;
    cursor: pointer;
    font-size: 24px;
    box-shadow: 0 4px 12px rgba(0,190,189,0.4);
    transition: transform 0.2s, box-shadow 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

  mainBtn.addEventListener("mouseenter", () => {
    mainBtn.style.transform = "scale(1.1)";
    mainBtn.style.boxShadow = "0 6px 16px rgba(0,190,189,0.5)";
  });
  mainBtn.addEventListener("mouseleave", () => {
    mainBtn.style.transform = "";
    mainBtn.style.boxShadow = "0 4px 12px rgba(0,190,189,0.4)";
  });
  mainBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  container.appendChild(menuPanel);
  container.appendChild(mainBtn);
  document.body.appendChild(container);

  // 不再监听点击其他区域关闭菜单
  // 只有点击主按钮才能切换菜单
}

/**
 * 切换菜单显示/隐藏
 */
function toggleMenu(show) {
  const panel = document.getElementById("boss-helper-menu-panel");
  if (!panel) return;

  const shouldShow = show !== undefined ? show : panel.style.display === "none";
  panel.style.display = shouldShow ? "flex" : "none";
}

/**
 * 创建通用弹窗容器
 */
function createModal(id, title, content, onClose, options = {}) {
  // 移除已有弹窗
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const maxWidth = options.maxWidth || "600px";
  const width = options.width || "95%";

  const overlay = document.createElement("div");
  overlay.id = id;
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

  const modal = document.createElement("div");
  modal.style.cssText = `
    background: white;
    border-radius: 12px;
    padding: 24px;
    max-width: ${maxWidth};
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    width: ${width};
  `;

  modal.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; color: #333; font-size: 18px;">${title}</h3>
      <button id="${id}-close-btn" style="
        background: none;
        border: none;
        font-size: 20px;
        cursor: pointer;
        color: #999;
        padding: 0;
        line-height: 1;
      ">✕</button>
    </div>
    <div id="${id}-content">${content}</div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // 关闭事件
  const closeModal = () => {
    overlay.remove();
    onClose?.();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  modal.querySelector(`#${id}-close-btn`).addEventListener("click", closeModal);

  return { overlay, modal, closeModal };
}

/**
 * 显示使用教程弹窗
 */
function showTutorial() {
  const content = `
    <div style="color: #444; font-size: 15px; line-height: 1.6;">

      <!-- 两个功能横向排列 -->
      <div style="display: flex; gap: 20px; margin-bottom: 24px;">

        <!-- 功能1：自动回复 -->
        <div style="flex: 1; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; border-radius: 14px; color: white;">
          <h4 style="margin: 0 0 16px; font-size: 20px;">🔄 自动回复</h4>

          <div style="font-size: 26px; font-weight: bold; margin-bottom: 16px;">
            告别重复回答
          </div>

          <!-- 解决方案 -->
          <div style="background: rgba(255,255,255,0.15); padding: 14px 16px; border-radius: 8px; margin-bottom: 14px;">
            <div style="font-size: 16px;">
              填好个人信息后，HR 提问时<strong>自动生成精准回复</strong>到输入框
            </div>
            <div style="font-size: 13px; opacity: 0.85; margin-top: 8px;">
              个人信息中没有的内容绝对不乱回答，回复精准可控
            </div>
          </div>

          <!-- 痛点 -->
          <div style="background: rgba(255,255,255,0.15); padding: 14px 16px; border-radius: 8px;">
            <div style="font-size: 14px; opacity: 0.9;">
              「在职还是离职？」「期望薪资？」「目前所在地？」<br>
              每天回答 50+ 次相同问题，烦不胜烦
            </div>
          </div>
        </div>

        <!-- 功能2：打招呼语 -->
        <div style="flex: 1; background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); padding: 24px; border-radius: 14px; color: white;">
          <h4 style="margin: 0 0 16px; font-size: 20px;">💬 智能打招呼</h4>

          <div style="font-size: 26px; font-weight: bold; margin-bottom: 16px;">
            告别已读不回
          </div>

          <!-- 解决方案 -->
          <div style="background: rgba(255,255,255,0.15); padding: 14px 16px; border-radius: 8px; margin-bottom: 14px;">
            <div style="font-size: 16px;">
              根据<strong>职位JD具体要求</strong>+<strong>你的真实经历</strong>，生成个性化开场白
            </div>
          </div>

          <!-- 痛点 -->
          <div style="background: rgba(255,255,255,0.15); padding: 14px 16px; border-radius: 8px;">
            <div style="font-size: 14px; opacity: 0.9;">
              群发「您好，对贵司岗位很感兴趣」<br>
              发了 100 条，回复的 HR 一只手数得过来
            </div>
          </div>
        </div>

      </div>

      <!-- 开始使用 -->
      <div style="background: #f8f9fa; padding: 24px; border-radius: 12px; text-align: center;">
        <div style="font-size: 17px; color: #333; margin-bottom: 16px; font-weight: 500;">🚀 两步开始使用</div>
        <div class="tutorial-action-buttons" style="display: flex; justify-content: center; gap: 20px;">
          <button type="button" class="tutorial-btn-api" style="
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 14px 32px;
            border-radius: 10px;
            font-size: 15px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 4px 14px rgba(102, 126, 234, 0.4);
            transition: transform 0.2s;
          ">
            1️⃣ 配置 API
          </button>
          <button type="button" class="tutorial-btn-profile" style="
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            color: white;
            border: none;
            padding: 14px 32px;
            border-radius: 10px;
            font-size: 15px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 4px 14px rgba(17, 153, 142, 0.4);
            transition: transform 0.2s;
          ">
            2️⃣ 填写个人信息
          </button>
        </div>
        <div style="margin-top: 16px; font-size: 13px; color: #666;">
          GitHub：<a href="https://github.com/Elucidator-hky/boss-" target="_blank" style="color: #667eea;">https://github.com/Elucidator-hky/boss-</a>
        </div>
      </div>
    </div>
  `;

  const { modal, closeModal } = createModal("boss-helper-tutorial", "📚 使用教程", content, null, { maxWidth: "80vw", width: "80vw" });

  // 绑定按钮点击事件
  const btnApi = modal.querySelector(".tutorial-btn-api");
  const btnProfile = modal.querySelector(".tutorial-btn-profile");

  if (btnApi) {
    btnApi.onmouseover = () => { btnApi.style.transform = "translateY(-2px)"; };
    btnApi.onmouseout = () => { btnApi.style.transform = "translateY(0)"; };
    btnApi.onclick = () => {
      closeModal();
      showApiConfig();
    };
  }

  if (btnProfile) {
    btnProfile.onmouseover = () => { btnProfile.style.transform = "translateY(-2px)"; };
    btnProfile.onmouseout = () => { btnProfile.style.transform = "translateY(0)"; };
    btnProfile.onclick = () => {
      closeModal();
      showProfileConfig();
    };
  }
}

/**
 * 显示API配置弹窗
 */
function showApiConfig() {
  // 先读取现有配置
  chrome.storage.local.get(["settings"], (result) => {
    const settings = result.settings || {};

    const content = `
      <div style="font-size: 14px;">
        <p style="margin: 0 0 16px; color: #666;">推荐模型：deepseek-chat、qwen-plus、qwen-max<br><span style="color: #999; font-size: 13px;">（推理模型更准但更慢：deepseek-reasoner、qwq-32b）</span></p>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; color: #333; font-weight: 500;">API Base <span style="color: #e74c3c;">*</span></label>
          <input id="api-config-base" type="text" value="${settings.api_base || ""}" placeholder="如 https://api.deepseek.com/v1" style="
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            box-sizing: border-box;
          ">
        </div>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; color: #333; font-weight: 500;">API Key <span style="color: #e74c3c;">*</span></label>
          <input id="api-config-key" type="password" value="${settings.api_key || ""}" placeholder="sk-..." style="
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            box-sizing: border-box;
          ">
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 4px; color: #333; font-weight: 500;">模型名 <span style="color: #e74c3c;">*</span></label>
          <input id="api-config-model" type="text" value="${settings.model || ""}" placeholder="如 deepseek-chat / qwen-plus" style="
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            box-sizing: border-box;
          ">
        </div>
        <div id="api-test-result" style="margin-bottom: 12px; padding: 10px; border-radius: 6px; display: none;"></div>
        <div style="display: flex; gap: 10px;">
          <button id="api-config-test" style="
            flex: 1;
            padding: 12px;
            background: #fff;
            color: #00bebd;
            border: 1px solid #00bebd;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
          ">测试连接</button>
          <button id="api-config-save" style="
            flex: 1;
            padding: 12px;
            background: #00bebd;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
          ">保存配置</button>
        </div>
      </div>
    `;

    const { closeModal } = createModal("boss-helper-api-config", "⚙️ 配置API", content);

    const resultEl = document.getElementById("api-test-result");

    // 测试连接
    document.getElementById("api-config-test").addEventListener("click", () => {
      const api_base = document.getElementById("api-config-base").value.trim();
      const api_key = document.getElementById("api-config-key").value.trim();
      const model = document.getElementById("api-config-model").value.trim();

      if (!api_base || !api_key || !model) {
        resultEl.style.display = "block";
        resultEl.style.background = "#fff3cd";
        resultEl.style.color = "#856404";
        resultEl.textContent = "请先填写完整的配置信息";
        return;
      }

      resultEl.style.display = "block";
      resultEl.style.background = "#e7f3ff";
      resultEl.style.color = "#0066cc";
      resultEl.textContent = "测试中...";

      const testBtn = document.getElementById("api-config-test");
      testBtn.disabled = true;
      testBtn.textContent = "测试中...";

      chrome.runtime.sendMessage({
        type: "TEST_API_CONNECTION",
        api_base,
        api_key,
        model
      }, (res) => {
        testBtn.disabled = false;
        testBtn.textContent = "测试连接";

        if (chrome.runtime.lastError) {
          resultEl.style.background = "#f8d7da";
          resultEl.style.color = "#721c24";
          resultEl.textContent = "测试失败: " + chrome.runtime.lastError.message;
          return;
        }

        if (res?.ok) {
          resultEl.style.background = "#d4edda";
          resultEl.style.color = "#155724";
          resultEl.textContent = "✓ 连接成功！模型响应正常";
        } else {
          resultEl.style.background = "#f8d7da";
          resultEl.style.color = "#721c24";
          resultEl.textContent = "✗ " + (res?.error || "连接失败");
        }
      });
    });

    // 保存事件
    document.getElementById("api-config-save").addEventListener("click", () => {
      const api_base = document.getElementById("api-config-base").value.trim();
      const api_key = document.getElementById("api-config-key").value.trim();
      const model = document.getElementById("api-config-model").value.trim();

      if (!api_base || !api_key || !model) {
        alert("请填写完整的API配置");
        return;
      }

      chrome.storage.local.set({ settings: { api_base, api_key, model } }, () => {
        alert("API配置已保存");
        closeModal();
      });
    });
  });
}

/**
 * 显示个人信息配置弹窗
 */
function showProfileConfig() {
  // 先读取现有配置
  chrome.storage.local.get(["profile_static"], (result) => {
    const profile = result.profile_static || {};
    const extras = profile.extras || {};

    // 通用样式
    const inputStyle = `
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      font-size: 13px;
      box-sizing: border-box;
      outline: none;
    `.replace(/\s+/g, " ");

    const labelStyle = `
      display: block;
      margin-bottom: 4px;
      color: #555;
      font-size: 12px;
    `.replace(/\s+/g, " ");

    // 生成已有的自定义字段
    const existingExtras = Object.entries(extras).map(([k, v]) => `
      <div class="extra-row" style="display: flex; gap: 8px; margin-bottom: 8px;">
        <input type="text" class="extra-key" value="${k}" placeholder="字段名" style="${inputStyle} width: 120px;">
        <input type="text" class="extra-value" value="${v}" placeholder="内容" style="${inputStyle} flex: 1;">
        <button type="button" class="extra-del" style="padding: 6px 10px; background: #ff5757; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">删除</button>
      </div>
    `).join("");

    const content = `
      <div style="font-size: 13px;">
        <p style="margin: 0 0 16px; color: #666; font-size: 12px; background: #f5f5f5; padding: 8px 12px; border-radius: 6px;">
          填写的信息将用于「自动回复」和「生成打招呼语」，信息越完整效果越好
        </p>

        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px;">
          <div>
            <label style="${labelStyle}">当前城市</label>
            <input id="profile-city" type="text" value="${profile.city || ""}" placeholder="北京" style="${inputStyle}">
          </div>
          <div>
            <label style="${labelStyle}">离职状态</label>
            <input id="profile-status" type="text" value="${profile.status || ""}" placeholder="已离职" style="${inputStyle}">
          </div>
          <div>
            <label style="${labelStyle}">工作年限</label>
            <input id="profile-years" type="text" value="${profile.years || ""}" placeholder="3年" style="${inputStyle}">
          </div>
          <div>
            <label style="${labelStyle}">学历</label>
            <input id="profile-degree" type="text" value="${profile.degree || ""}" placeholder="本科" style="${inputStyle}">
          </div>
          <div>
            <label style="${labelStyle}">求职方向</label>
            <input id="profile-direction" type="text" value="${profile.direction || ""}" placeholder="Java后端" style="${inputStyle}">
          </div>
          <div>
            <label style="${labelStyle}">技术栈</label>
            <input id="profile-tech" type="text" value="${profile.tech_stack || ""}" placeholder="Java, Spring" style="${inputStyle}">
          </div>
          <div>
            <label style="${labelStyle}">上一份薪资</label>
            <input id="profile-salary" type="text" value="${profile.salary_prev || ""}" placeholder="25k×16" style="${inputStyle}">
          </div>
          <div>
            <label style="${labelStyle}">到岗时间</label>
            <input id="profile-leave-time" type="text" value="${profile.leave_time || ""}" placeholder="随时" style="${inputStyle}">
          </div>
          <div>
            <label style="${labelStyle}">离职原因</label>
            <input id="profile-leave-reason" type="text" value="${profile.leave_reason || ""}" placeholder="项目收尾" style="${inputStyle}">
          </div>
        </div>

        <div style="margin-bottom: 16px;">
          <label style="${labelStyle}">职业技能</label>
          <textarea id="profile-skills" rows="3" placeholder="熟练掌握 Java、Spring Boot、MyBatis，有微服务开发经验" style="${inputStyle} resize: vertical; line-height: 1.5;">${profile.skills || ""}</textarea>
        </div>

        <div style="margin-bottom: 16px;">
          <label style="${labelStyle}">项目经验</label>
          <textarea id="profile-projects" rows="3" placeholder="订单系统重构，将QPS从500提升到5000" style="${inputStyle} resize: vertical; line-height: 1.5;">${profile.projects || ""}</textarea>
        </div>

        <div style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <label style="color: #555; font-size: 12px;">自定义字段</label>
            <button id="add-extra-btn" type="button" style="padding: 4px 12px; background: #00bebd; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">+ 添加</button>
          </div>
          <div id="extras-container">
            ${existingExtras}
          </div>
        </div>

        <button id="profile-config-save" style="
          width: 100%;
          padding: 12px;
          background: linear-gradient(135deg, #00bebd 0%, #00a8a7 100%);
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
        ">保存个人信息</button>
      </div>
    `;

    const { closeModal } = createModal("boss-helper-profile-config", "👤 个人信息", content, null, { maxWidth: "70vw" });

    // 添加自定义字段
    document.getElementById("add-extra-btn").addEventListener("click", () => {
      const container = document.getElementById("extras-container");
      const row = document.createElement("div");
      row.className = "extra-row";
      row.style.cssText = "display: flex; gap: 8px; margin-bottom: 8px;";
      row.innerHTML = `
        <input type="text" class="extra-key" placeholder="字段名" style="${inputStyle} width: 120px;">
        <input type="text" class="extra-value" placeholder="内容" style="${inputStyle} flex: 1;">
        <button type="button" class="extra-del" style="padding: 6px 10px; background: #ff5757; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">删除</button>
      `;
      container.appendChild(row);
      row.querySelector(".extra-del").addEventListener("click", () => row.remove());
    });

    // 绑定已有删除按钮
    document.querySelectorAll(".extra-del").forEach(btn => {
      btn.addEventListener("click", () => btn.closest(".extra-row").remove());
    });

    // 保存事件
    document.getElementById("profile-config-save").addEventListener("click", () => {
      // 收集自定义字段
      const extrasObj = {};
      document.querySelectorAll("#extras-container .extra-row").forEach(row => {
        const key = row.querySelector(".extra-key").value.trim();
        const value = row.querySelector(".extra-value").value.trim();
        if (key) extrasObj[key] = value;
      });

      const profile_static = {
        schema_version: 1,
        city: document.getElementById("profile-city").value.trim(),
        status: document.getElementById("profile-status").value.trim(),
        years: document.getElementById("profile-years").value.trim(),
        degree: document.getElementById("profile-degree").value.trim(),
        direction: document.getElementById("profile-direction").value.trim(),
        tech_stack: document.getElementById("profile-tech").value.trim(),
        salary_prev: document.getElementById("profile-salary").value.trim(),
        leave_time: document.getElementById("profile-leave-time").value.trim(),
        leave_reason: document.getElementById("profile-leave-reason").value.trim(),
        skills: document.getElementById("profile-skills").value.trim(),
        projects: document.getElementById("profile-projects").value.trim(),
        extras: extrasObj
      };

      chrome.storage.local.set({ profile_static }, () => {
        alert("个人信息已保存");
        closeModal();
      });
    });
  });
}

/**
 * 打开配置页（带锚点定位）- 保留备用
 */
function openOptionsPage(section) {
  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
  if (!runtime) return;

  runtime.sendMessage({ type: "OPEN_OPTIONS", section });
}

/**
 * 切换自动回复开关
 */
function toggleAutoReply() {
  autoReplyEnabled = !autoReplyEnabled;

  // 更新 UI
  const toggle = document.getElementById("boss-helper-auto-reply-toggle");
  if (toggle) {
    toggle.textContent = autoReplyEnabled ? "开" : "关";
    toggle.style.background = autoReplyEnabled ? "#00bebd" : "#ccc";
  }

  // 保存状态
  chrome.storage.local.set({ auto_reply_enabled: autoReplyEnabled });

  console.log("[AutoReply]", autoReplyEnabled ? "已开启" : "已关闭");

  // 开关打开时，立即触发一次自动回复
  if (autoReplyEnabled && triggerAutoReplyCallback) {
    triggerAutoReplyCallback();
  }
}

/**
 * 检查 API 配置是否完整
 */
function checkApiConfig(callback) {
  chrome.storage.local.get(["settings"], (result) => {
    const settings = result.settings || {};
    if (!settings.api_base || !settings.api_key || !settings.model) {
      callback(false);
    } else {
      callback(true);
    }
  });
}

/**
 * 处理AI打招呼
 */
function handleGreeting() {
  checkApiConfig((isConfigured) => {
    if (!isConfigured) {
      alert("请先配置 API（点击菜单「⚙️ 配置API」）");
      return;
    }
    generateGreeting();
  });
}

// 生成中状态标记
let isGeneratingGreeting = false;

/**
 * 生成打招呼语
 */
function generateGreeting() {
  if (isGeneratingGreeting) return; // 防止重复点击

  if (!currentJobData?.encryptJobId) {
    alert("请先选择一个会话");
    return;
  }

  isGeneratingGreeting = true;

  // 更新主按钮状态
  const mainBtn = document.getElementById("boss-helper-main-btn");
  const originalBtnContent = mainBtn?.innerHTML;
  if (mainBtn) {
    mainBtn.innerHTML = "⏳";
    mainBtn.disabled = true;
  }

  // 更新菜单项状态
  const greetingMenuItem = document.querySelector("#boss-helper-menu-panel > div:last-child");
  const originalMenuText = greetingMenuItem?.querySelector("span:last-child")?.textContent;
  if (greetingMenuItem) {
    const textSpan = greetingMenuItem.querySelector("span:last-child");
    if (textSpan) textSpan.textContent = "生成中...";
    greetingMenuItem.style.opacity = "0.7";
    greetingMenuItem.style.pointerEvents = "none";
  }

  const restore = () => {
    isGeneratingGreeting = false;
    if (mainBtn) {
      mainBtn.innerHTML = originalBtnContent || "🤖";
      mainBtn.disabled = false;
    }
    if (greetingMenuItem) {
      const textSpan = greetingMenuItem.querySelector("span:last-child");
      if (textSpan) textSpan.textContent = originalMenuText || "生成打招呼语";
      greetingMenuItem.style.opacity = "";
      greetingMenuItem.style.pointerEvents = "";
    }
  };

  const doGenerate = () => {
    // 组装职位信息
    const jobInfo = {
      jobName: currentJobData?.jobName || currentJobInfo?.title || "",
      salary: currentJobData?.salaryDesc || currentJobInfo?.salary || "",
      city: currentJobData?.locationName || currentJobInfo?.city || "",
      company: currentJobData?.companyName || currentJobInfo?.company || "",
      hrName: currentJobData?.bossName || currentJobInfo?.hrName || "",
      hrTitle: currentJobData?.bossTitle || currentJobInfo?.hrTitle || "",
      description: currentJobDescription || currentJobInfo?.description || ""
    };

    const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
    runtime.sendMessage({
      type: "GENERATE_GREETING",
      jobInfo
    }, (res) => {
      restore();

      if (runtime.lastError) {
        console.error("[Greeting] 生成失败:", runtime.lastError.message);
        return;
      }
      if (!res?.ok) {
        alert("生成失败: " + (res?.error || "未知错误"));
        return;
      }

      // 填充到输入框
      const inputEl = document.getElementById("chat-input");
      if (inputEl && res.greeting) {
        fillChatInput(inputEl, res.greeting);
      }
    });
  };

  // 如果没有完整 JD，先获取
  if (!currentJobDescription && currentJobData?.encryptJobId) {
    fetchFullJobDescription(() => {
      doGenerate();
    });
  } else {
    doGenerate();
  }
}

// ============================================================================
// 主入口
// ============================================================================

function watchImListAsDialogue() {
  // 只在聊天页运行
  if (!location.pathname.includes("/web/geek/chat")) return;

  const ul = document.querySelector("ul.im-list");
  if (!ul) {
    console.log("[im-list] not found, retry...");
    setTimeout(watchImListAsDialogue, 1000);
    return;
  }

  // 会话状态
  let lastPrinted = "";
  let timer = null;
  let lastHrMid = null;
  let typedAfterHr = false;
  let isComposing = false;

  // 获取输入框
  const getChatInputEl = () => document.getElementById("chat-input");

  // 监听输入框事件
  setupInputListeners();

  // 创建悬浮菜单
  createFloatingMenu();

  // 初始化
  lastHrMid = null;  // 初始为 null，这样首次检测到 HR 消息时会触发

  // 设置全局回调，供开关切换时调用
  triggerAutoReplyCallback = () => {
    console.log("[callback] 开关打开，触发自动回复");
    sendToLLM();
  };

  // 监听 DOM 变化
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(emit, 200);
  });

  observer.observe(ul, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // 绑定 observer 后立即检查一次
  emit();

  // ==========================================================================
  // 输入框监听
  // ==========================================================================

  /**
   * 监听输入框：用户有输入则不自动填充
   */
  function setupInputListeners() {
    const inputEl = getChatInputEl();
    if (!inputEl) return;

    inputEl.addEventListener("keydown", () => {
      typedAfterHr = true;
    });
    inputEl.addEventListener("paste", () => {
      typedAfterHr = true;
    });
    inputEl.addEventListener("compositionstart", () => {
      isComposing = true;
      typedAfterHr = true;
    });
    inputEl.addEventListener("compositionend", () => {
      isComposing = false;
    });
  }

  // ==========================================================================
  // 输入框操作
  // ==========================================================================

  /**
   * 判断输入框是否为空
   */
  function isChatInputEmpty(el) {
    if (!el) return true;

    const text = String(el.innerText || "").replace(/\u200b/g, "").trim();
    if (text) return false;

    const html = String(el.innerHTML || "")
      .replace(/\u200b/g, "")
      .replace(/&nbsp;/gi, "")
      .trim()
      .toLowerCase();

    if (!html) return true;
    if (html.replace(/<br\s*\/?>/g, "").trim() === "") return true;
    if (html.replace(/<(div|p)>\s*<\/(div|p)>/g, "").trim() === "") return true;

    return true;
  }

  // ==========================================================================
  // 消息提取
  // ==========================================================================

  /**
   * 清理多余空白
   */
  function clean(s) {
    return (s || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * 从消息 li 中提取文本
   */
  function extractText(li) {
    // 跳过竞争者PK消息
    if (li.innerText && li.innerText.includes("你与该职位竞争者PK情况")) {
      return null;
    }

    // 图片消息
    if (li.querySelector(".item-image") || li.querySelector(".message-image")) {
      return "[图片]";
    }

    // 卡片消息 - 提取标题/问题部分，忽略按钮
    const cardTitle = li.querySelector(".message-card-top-title");
    if (cardTitle) {
      return clean(cardTitle.innerText);
    }

    // 对话框消息（如工作地点确认）
    const dialogTitle = li.querySelector(".msg-dialog-title");
    if (dialogTitle) {
      const location = li.querySelector(".msg-dialog-desc");
      let text = dialogTitle.innerText;
      if (location) {
        text += " " + location.innerText;
      }
      return clean(text);
    }

    // 普通文本消息 - 只取 .text p span 内容，避免采集按钮等
    const textSpan = li.querySelector(".message-content .text p span");
    if (textSpan) {
      let text = textSpan.innerText;
      // 过滤状态文本
      text = text.replace(/已读\s*/g, "").replace(/送达\s*/g, "").trim();
      return clean(text);
    }

    // 兜底
    const textNode =
      li.querySelector(".message-content .text") ||
      li.querySelector(".message-content") ||
      li.querySelector(".text");

    if (!textNode) return null;

    let text = textNode.innerText;
    // 过滤状态文本
    text = text.replace(/已读\s*/g, "").replace(/送达\s*/g, "").trim();
    return clean(text);
  }

  /**
   * 收集对话消息（易读格式）
   */
  function collectChatMessages(max = 20) {
    const lis = Array.from(ul.querySelectorAll("li.message-item")).slice(-max);
    const lines = [];

    for (const li of lis) {
      const who = li.classList.contains("item-friend")
        ? "HR"
        : li.classList.contains("item-myself")
          ? "我"
          : li.classList.contains("item-system")
            ? "系统提示"
            : null;
      if (!who) continue;

      let text = extractText(li);
      if (!text) continue;

      // 把消息内的换行替换为空格，保持每条消息一行
      text = text.replace(/\n+/g, " ").trim();

      // 用方括号框起来，让消息边界更清晰
      lines.push(`${who}：[${text}]`);
    }

    return lines.join("\n");
  }

  /**
   * 获取最后一条 HR 消息的 mid
   */
  function getLastHrMid() {
    const hrLis = ul.querySelectorAll("li.message-item.item-friend");
    if (!hrLis.length) return null;
    const last = hrLis[hrLis.length - 1];
    return last.getAttribute("data-mid") || null;
  }

  /**
   * 格式化对话用于打印
   */
  function stringifyDialogue() {
    const lis = ul.querySelectorAll("li.message-item");
    const lines = [];

    for (const li of lis) {
      const who = li.classList.contains("item-friend")
        ? "HR"
        : li.classList.contains("item-myself")
          ? "我"
          : li.classList.contains("item-system")
            ? "系统"
            : "未知";

      // 系统消息可以保留用于日志，但不参与 LLM 对话
      const text = extractText(li);
      if (!text) continue;

      const time = clean(li.querySelector(".item-time .time")?.innerText || "");
      const prefix = time ? `[${who}｜${time}]` : `[${who}]`;
      lines.push(`${prefix} ${text}`);
    }

    return lines.join("\n");
  }

  // ==========================================================================
  // LLM 调用
  // ==========================================================================

  /**
   * 发送消息给后台调用大模型
   */
  function sendToLLM() {
    // 检查自动回复开关
    if (!autoReplyEnabled) {
      console.log("[LLM] 自动回复已关闭，跳过");
      return;
    }

    // 检查 chrome.storage 是否可用
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) {
      console.log("[LLM] chrome.storage 不可用，跳过");
      return;
    }

    // 检查 API 配置
    storage.get(["settings"], (result) => {
      const settings = result.settings || {};
      if (!settings.api_base || !settings.api_key || !settings.model) {
        console.log("[LLM] API 未配置，跳过自动回复");
        return;
      }

      const dialogue = collectChatMessages(20);
      if (!dialogue) return;

      const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
      if (!runtime?.sendMessage || !runtime?.id) {
        console.error("[LLM] chrome.runtime 不可用：请确认扩展已正常加载并在扩展上下文中运行。");
        return;
      }

      try {
        runtime.sendMessage({ type: "LLM_CHAT", dialogue }, (res) => {
          if (runtime.lastError) {
            console.error("[LLM] runtime error:", runtime.lastError.message);
            return;
          }
          if (!res?.ok) {
            console.error("[LLM] failed:", res?.error);
            return;
          }

          if (res.debug_request) {
            console.log("[LLM] request json:", res.debug_request);
          }
          if (res.debug_response) {
            console.log("[LLM] response json:", res.debug_response);
          }

          if (!res.can_answer) {
            console.log("[LLM] can_answer=false");
            return;
          }

          console.log("[LLM] reply:\n" + res.reply);

          // 自动填充判断
          const inputEl = getChatInputEl();
          if (!inputEl) return;
          if (!isChatInputEmpty(inputEl)) return;
          if (isComposing) return;
          if (typedAfterHr) return;

          fillChatInput(inputEl, res.reply || "");
        });
      } catch (err) {
        console.error("[LLM] sendMessage failed:", err?.message || String(err));
      }
    });
  }

  // ==========================================================================
  // 事件触发
  // ==========================================================================

  /**
   * DOM 变化后触发：打印对话 + 新 HR 消息时调用模型
   */
  function emit() {
    // 打印对话
    const dialogue = stringifyDialogue();
    if (dialogue && dialogue !== lastPrinted) {
      lastPrinted = dialogue;
      console.log("[im-list] dialogue:\n" + dialogue);
    }

    // 新 HR 消息才调用模型
    const hrMid = getLastHrMid();
    if (!hrMid || hrMid === lastHrMid) return;

    typedAfterHr = false;
    lastHrMid = hrMid;

    console.log("[LLM] new HR message -> call llm, mid:", hrMid);
    sendToLLM();
  }
}

// 启动
watchImListAsDialogue();

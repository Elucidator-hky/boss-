/**
 * Options 页面脚本（最小实现）
 * 功能：
 * 1) 保存模型配置（api_base / api_key / model）到 chrome.storage.local.settings
 * 2) 保存个人信息到 chrome.storage.local.profile_static
 */

const DEFAULT_SETTINGS = {
  api_base: "",
  api_key: "",
  model: ""
};

const DEFAULT_PROFILE = {
  schema_version: 1,
  city: "",
  status: "",
  years: "",
  degree: "",
  direction: "",
  tech_stack: "",
  salary_prev: "",
  leave_time: "",
  leave_reason: "",
  skills: "",
  projects: "",
  extras: {}
};

/**
 * Promise 版 storage.get（避免 callback 写法难读）。
 */
function storageGet(keys) {
  return new Promise((resolve, reject) => {
    const storage = chrome?.storage?.local;
    if (!storage) {
      reject(new Error("未找到 chrome.storage.local（请在扩展的配置页里打开）"));
      return;
    }
    storage.get(keys, (items) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(err);
      else resolve(items);
    });
  });
}

/**
 * Promise 版 storage.set。
 */
function storageSet(payload) {
  return new Promise((resolve, reject) => {
    const storage = chrome?.storage?.local;
    if (!storage) {
      reject(new Error("未找到 chrome.storage.local（请在扩展的配置页里打开）"));
      return;
    }
    storage.set(payload, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 把表单字段读成对象。
 */
function readForm(form) {
  const fd = new FormData(form);
  return Object.fromEntries(fd.entries());
}

/**
 * 把对象回填到表单里（按 name 匹配）。
 */
function fillForm(form, data) {
  if (!form) return;
  Object.entries(data || {}).forEach(([key, value]) => {
    const input = form.querySelector(`[name='${key}']`);
    if (!input) return;
    input.value = value ?? "";
  });

  // extras 是 textarea，多行 key:value
  const extrasEl = form.querySelector("[name='extras']");
  if (extrasEl && data?.extras && typeof data.extras === "object") {
    extrasEl.value = Object.entries(data.extras)
      .map(([k, v]) => `${k}:${v}`)
      .join("\n");
  }
}

/**
 * 填充模型配置表单
 */
function fillSettingsForm(form, settings) {
  if (!form) return;
  const s = { ...DEFAULT_SETTINGS, ...settings };

  form.querySelector("[name='api_base']").value = s.api_base || "";
  form.querySelector("[name='api_key']").value = s.api_key || "";
  form.querySelector("[name='model']").value = s.model || "";
}

/**
 * 把 textarea 的 key:value 文本解析成对象。
 */
function parseExtras(text) {
  const extras = {};
  String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [k, ...rest] = line.split(":");
      if (!k) return;
      extras[k.trim()] = rest.join(":").trim();
    });
  return extras;
}

/**
 * 页面初始化：从 storage 读取数据并回填。
 */
async function init() {
  const settingsForm = document.getElementById("settings-form");
  const profileForm = document.getElementById("profile-form");

  if (!settingsForm || !profileForm) {
    console.error("未找到表单节点：", { settingsForm, profileForm });
    alert("配置页加载失败：未找到表单，请刷新页面重试。");
    return;
  }

  settingsForm.addEventListener("submit", (e) => handleSaveSettings(e, settingsForm));
  profileForm.addEventListener("submit", (e) => handleSaveProfile(e, profileForm));

  try {
    const { settings, profile_static, _scroll_to_section } = await storageGet([
      "settings",
      "profile_static",
      "_scroll_to_section"
    ]);
    fillSettingsForm(settingsForm, settings);
    fillForm(profileForm, { ...DEFAULT_PROFILE, ...(profile_static || {}) });

    // 滚动到指定区块
    if (_scroll_to_section) {
      const target = document.getElementById(_scroll_to_section);
      if (target) {
        setTimeout(() => {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          // 高亮效果
          target.style.transition = "box-shadow 0.3s";
          target.style.boxShadow = "0 0 0 3px #00bebd";
          setTimeout(() => {
            target.style.boxShadow = "";
          }, 1500);
        }, 100);
      }
      // 清除标记
      chrome.storage.local.remove("_scroll_to_section");
    }
  } catch (err) {
    console.error(err);
    alert(err?.message || "读取配置失败");
  }
}

/**
 * 保存模型配置。
 */
async function handleSaveSettings(e, settingsForm) {
  e.preventDefault();
  const raw = readForm(settingsForm);

  const settings = {
    api_base: String(raw.api_base || "").trim(),
    api_key: String(raw.api_key || "").trim(),
    model: String(raw.model || "").trim()
  };

  const missing = [];
  if (!settings.api_base) missing.push("API Base");
  if (!settings.api_key) missing.push("API Key");
  if (!settings.model) missing.push("模型名");

  if (missing.length) {
    alert(`配置未填：${missing.join("、")}`);
    return;
  }

  try {
    await storageSet({ settings });
    console.log("[BOSS Chat Assistant] 模型配置已保存:", settings);
    alert("模型配置已保存");
  } catch (err) {
    console.error(err);
    alert(err?.message || "保存模型配置失败");
  }
}

/**
 * 保存个人信息。
 */
async function handleSaveProfile(e, profileForm) {
  e.preventDefault();
  const raw = readForm(profileForm);

  const required = ["city", "status", "years", "degree", "direction", "tech_stack"];
  const missing = required.filter((k) => !String(raw[k] || "").trim());
  if (missing.length) {
    alert(`个人信息未填：${missing.join("，")}`);
    return;
  }

  const profile_static = {
    schema_version: DEFAULT_PROFILE.schema_version,
    city: String(raw.city || "").trim(),
    status: String(raw.status || "").trim(),
    years: String(raw.years || "").trim(),
    degree: String(raw.degree || "").trim(),
    direction: String(raw.direction || "").trim(),
    tech_stack: String(raw.tech_stack || "").trim(),
    salary_prev: String(raw.salary_prev || "").trim(),
    leave_time: String(raw.leave_time || "").trim(),
    leave_reason: String(raw.leave_reason || "").trim(),
    skills: String(raw.skills || "").trim(),
    projects: String(raw.projects || "").trim(),
    extras: parseExtras(raw.extras)
  };

  try {
    await storageSet({ profile_static });
    console.log("[BOSS Chat Assistant] 个人信息已保存");
    alert("个人信息已保存");
  } catch (err) {
    console.error(err);
    alert(err?.message || "保存个人信息失败");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

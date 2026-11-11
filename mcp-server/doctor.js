import { openBridge } from "./bridge-client.js";
import { VERSION } from "./bridge-runtime.js";

let bridge;
try {
  bridge = await openBridge();
  const status = await bridge.call("connection_status");
  console.log(JSON.stringify(status, null, 2));
  if (!status.extensionConnected) {
    console.error("扩展未连接：在 Chrome 加载仓库根目录的扩展，打开 Boss 并刷新页面后重试。");
    process.exitCode = 1;
  } else if (status.extensionVersion !== VERSION) {
    console.error("扩展版本不匹配：请重载 Chrome 扩展并刷新 Boss 页面后重试。");
    process.exitCode = 1;
  } else {
    console.log("桥接与扩展已连接。请让 AI 调用 read_current_page 核对页面、登录账号和当前对话；本自检不执行投递。");
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally { bridge?.close(); }

#!/bin/zsh
# 盯梢 Boss 新消息信号文件：检测到新行(=扩展检测到新消息)就打印内容并退出，
# 退出会触发 Claude Code 的 task-notification 唤醒我。处理完我会再挂一个（自循环）。
# 用「行数」而非 mtime，处理期间来的消息不会漏：重挂时行数已增会立即再触发。
# 信号文件路径：与 server.js 保持一致——优先环境变量，否则脚本所在目录（项目根）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIG="${BOSS_SIGNAL_FILE:-$SCRIPT_DIR/.new-message-signal}"
BASE=$(wc -l < "$SIG" 2>/dev/null || echo 0)
while true; do
  sleep 1
  CUR=$(wc -l < "$SIG" 2>/dev/null || echo "$BASE")
  if [ "$CUR" -gt "$BASE" ]; then
    echo "BOSS_NEW_MESSAGE 有 $((CUR - BASE)) 条新信号（HR 给你发消息了）："
    tail -n $((CUR - BASE)) "$SIG"
    exit 0
  fi
done

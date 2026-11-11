#!/bin/zsh
# 盯梢 Boss 新消息信号文件：检测到新行(=扩展检测到新消息)就打印内容并退出，
# 退出会触发 Claude Code 的 task-notification 唤醒我。处理完我会再挂一个（自循环）。
# 信号文件路径：与 server.js 保持一致——优先环境变量，否则脚本所在目录（项目根）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIG="${BOSS_SIGNAL_FILE:-$SCRIPT_DIR/.new-message-signal}"
# ⚠️ 游标持久化（2026-08-07 修复）：基线不能取"挂载时行数"——
# pkill 旧盯梢 → 挂新盯梢 的空窗期里到达的信号会被基线吞掉，永远不触发
# （8/7 实证：HR 秒回落在空窗，漏掉当前对话回复）。
# 改为把"已消费行数"存 cursor 文件：启动时从 cursor 算起，空窗期信号立即触发。
CUR_FILE="${BOSS_CURSOR_FILE:-$SIG.cursor}"
NOW=$(wc -l < "$SIG" 2>/dev/null || echo 0)
BASE=$(cat "$CUR_FILE" 2>/dev/null || echo "$NOW")
# 首次挂载也落盘，重挂期间收到的新信号才能被保留。
echo "$BASE" > "$CUR_FILE"
# 信号文件被清空/轮转（cursor 大于实际行数）时重置
if [ "$BASE" -gt "$NOW" ]; then BASE="$NOW"; echo "$BASE" > "$CUR_FILE"; fi
# 超时兜底：MV3 service worker 被 Chrome 回收的瞬间到达的消息，其 new_message 事件会丢
# 且不重发（2026-08-06 实证漏过消息）。纯事件驱动不可靠，加定时兜底：
# 跑满 MAX_WAIT 秒无信号也退出唤醒 Claude，由 Claude 主动查红点+当前对话补漏。
MAX_WAIT="${BOSS_WATCH_TIMEOUT:-600}"
WAITED=0
while true; do
  CUR=$(wc -l < "$SIG" 2>/dev/null || echo "$BASE")
  if [ "$CUR" -lt "$BASE" ]; then BASE="$CUR"; echo "$BASE" > "$CUR_FILE"; fi
  if [ "$CUR" -gt "$BASE" ]; then
    echo "BOSS_NEW_MESSAGE 有 $((CUR - BASE)) 条新信号（HR 给你发消息了）："
    tail -n $((CUR - BASE)) "$SIG"
    echo "$CUR" > "$CUR_FILE"
    exit 0
  fi
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "BOSS_WATCH_TIMEOUT ${MAX_WAIT}s 无信号，例行兜底唤醒：请查顶部红点 + read_current_page 当前对话，处理完重挂。"
    exit 0
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

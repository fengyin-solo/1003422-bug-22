import { resumePendingActions } from '@/api/local-service'

// 操作日志的自动续传：页面打开时先补跑一次；网络从断开恢复后再补跑。
// 续传只走未完成步骤，台账落库步骤已完成的动作不会重复写库。
export function setupActionRecovery(): void {
  if (typeof window === 'undefined') {
    return
  }
  const flush = () => {
    try {
      resumePendingActions()
    } catch {
      // 通道仍不可用：日志保留，等下一次 online 再续。
    }
  }
  window.addEventListener('online', flush)
  // 首屏挂载时延迟一拍，避免和首屏读数据抢 localStorage。
  window.setTimeout(flush, 0)
}
